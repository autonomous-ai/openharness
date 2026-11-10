// An agent's instructions file, read and saved from another of the owner's computers (agent_instructions_read and
// agent_instructions_write, answered by the project readers, services/projects.ts). What the person wrote there is
// theirs: it never goes through GitHub or our servers, so on the relay it is sealed both ways and never logged, and only
// the account's own computers may ask, never a guest or a collaborator.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendSocket } from './backendSocket.js'
import { env } from './config/env.js'
import type { RemoteClient } from './core/api.js'
import { encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './lib/e2ee/applicationFrames.js'
import * as logModule from './lib/log.js'
import type { RegisteredSession } from './lib/registry.js'
import { startProjects } from './services/projects.js'
import { fakeCore } from './testing/fakeCore.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from './testing/relaySocket.js'

type Frame = { type: string; payload: Record<string, unknown> }
const TYPES = ['agent_instructions_read', 'agent_instructions_write'] as const
/** How long a reply may take before a spec gives up on it: the daemon's own work is milliseconds, and a busy machine is not
 *  what these specs are about. */
const SETTLED = { timeout: 10_000 }
const sealedFrame = (type: string) => ({ type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } })

describe('an agent\'s instructions file through the socket', () => {
  let cwd: string
  let socket: BackendSocket
  const sockets: BackendSocket[] = []

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'harness-instructions-socket-'))
    await mkdir(join(cwd, 'agents'))
    await writeFile(join(cwd, 'agents', 'Faye.md'), 'SECRET words')
    // What else instructs the agent, in its folder: read with its own file, and as much the person's own words as it is.
    await writeFile(join(cwd, 'AGENTS.md'), 'SECRET shared words')
    socket = relaySocket('fixture')
    sockets.push(socket)
    // The real project readers answer, over a real folder: what the socket hands them is what they trust.
    const requests = startProjects(fakeCore({ agents: { resolve: (id: string) => id === 'a1' ? { agentId: 'a1', sessionId: 's-a1', cwd } as RegisteredSession : undefined } }))
    socket.serviceRouter = (type, payload, asker, reply) => {
      if (type === 'machine_resources') { reply({ cpu: 1 }); return true }
      const handler = requests[type]
      if (!handler) return false
      void Promise.resolve(handler(payload, asker)).then(reply)
      return true
    }
  })
  afterEach(async () => {
    for (const one of sockets.splice(0)) await one.stop()
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true })
  })

  it('is sealed both ways, for a daemon that opens the formerly plain requests and one that does not', () => {
    for (const type of TYPES) {
      expect(encryptDownFrame(type), type).toBe(true)
      expect(encryptDownFrameFor(type, { strictDown: false }), type).toBe(true)
      expect(encryptDownFrameFor(type, { strictDown: true }), type).toBe(true)
      expect(encryptRpcResult(`${type}_result`), `${type}_result`).toBe(true)
    }
    // The lists name these two and nothing near them.
    expect(encryptDownFrame('agent_instructions_other')).toBe(false)
    expect(encryptRpcResult('agent_instructions_other_result')).toBe(false)
  })

  /** A relayed session of `web` role: the owner's own app, or a collaborator the host account does not vouch for. */
  function relayed(accountOwner: boolean, role: 'web' | 'device' = 'web') {
    const gw = gatewayOf(socket)
    vi.spyOn(gw.e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gw.e2ee, 'sessionRole').mockReturnValue(role)
    const client: RemoteClient = { role, label: null, identity: 'identity', direct: false, accountOwner }
    ;(socket as unknown as { remoteClients: Map<string, RemoteClient> }).remoteClients.set('web-1', client)
    const wrap = vi.spyOn(gw.e2ee, 'wrapRpcReply').mockImplementation((_conn, type) => ({ type, payload: { __e2e: 'sealed' } }) as never)
    const queued: unknown[] = []
    vi.spyOn(upstreamOf(socket) as unknown as { enqueue: (message: unknown) => void }, 'enqueue').mockImplementation((message) => { queued.push(message) })
    const ask = async (type: string, payload: Record<string, unknown>) => {
      vi.spyOn(gw.e2ee, 'unwrapDown').mockReturnValue({ type, payload: { requestId: 'r-1', ...payload } })
      await dispatchDown(socket, sealedFrame(type), 'web-1', 'relay')
    }
    const replied = () => wrap.mock.calls.map(([, type, , payload]) => ({ type, payload: payload as Record<string, unknown> }))
    return { ask, replied, queued }
  }

  it('is answered to the account\'s own computer, sealed to that connection alone, and never in the clear', async () => {
    const { ask, replied, queued } = relayed(true)
    await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
    await vi.waitFor(() => expect(replied()).toHaveLength(1), SETTLED)
    const [{ payload: read }] = replied()
    expect(read).toEqual({ text: 'SECRET words', version: expect.stringMatching(/^[0-9a-f]{64}$/), shared: [{ name: 'AGENTS.md', path: 'AGENTS.md', loadedBy: ['codex'], text: 'SECRET shared words', truncated: false }] })
    await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'SECRET rewrite', version: read.version })
    await vi.waitFor(() => expect(replied()).toHaveLength(2), SETTLED)
    expect(replied().map((reply) => reply.type)).toEqual(['agent_instructions_read_result', 'agent_instructions_write_result'])
    expect(await readFile(join(cwd, 'agents', 'Faye.md'), 'utf8')).toBe('SECRET rewrite')
    // Whatever reached the relay's queue is the sealed stub, never the text or the version.
    expect(JSON.stringify(queued)).not.toContain('SECRET')
    expect(JSON.stringify(queued)).not.toContain(String(read.version))
  })

  it('refuses a collaborator the host account does not vouch for, and a device, sealed, with the file untouched', async () => {
    for (const [accountOwner, role] of [[false, 'web'], [true, 'device']] as const) {
      const { ask, replied } = relayed(accountOwner, role)
      await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
      await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'planted', version: '' })
      await vi.waitFor(() => expect(replied()).toHaveLength(2), SETTLED)
      expect(replied().map((reply) => reply.payload), role).toEqual([{ error: 'OWNER_REQUIRED' }, { error: 'OWNER_REQUIRED' }])
      expect(await readFile(join(cwd, 'agents', 'Faye.md'), 'utf8')).toBe('SECRET words')
      vi.restoreAllMocks()
    }
  })

  it('takes nothing that arrives unsealed: the service is never asked, and the text it carried is not answered back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enqueue = vi.spyOn(upstreamOf(socket) as unknown as { enqueue: (message: unknown) => void }, 'enqueue').mockImplementation(() => {})
    const routed = vi.fn(() => true)
    socket.serviceRouter = routed
    for (const type of TYPES) await dispatchDown(socket, { type, payload: { requestId: 'r-1', agentId: 'a1', name: 'Faye', text: 'PLAIN', version: '' } }, 'web-1', 'relay')
    expect(routed).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(enqueue.mock.calls)).toContain('E2EE_REQUIRED')
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('PLAIN')
    expect(await readFile(join(cwd, 'agents', 'Faye.md'), 'utf8')).toBe('SECRET words')
  })

  it('keeps the requests and their replies out of the frame log: it is the person\'s own words', async () => {
    const wasOn = env.LOG_FRAMES
    env.LOG_FRAMES = true
    const logged = vi.spyOn(logModule, 'logFrame').mockImplementation(() => {})
    const frames: Frame[] = []
    socket.registerLocalClient('local:w', { sendFrame: (frame) => { frames.push(frame as Frame); return true }, sendBinary: () => true })
    try {
      // From a window on this computer, and from another of the owner's computers over the relay.
      socket.handleLocalFrame('local:w', { type: 'agent_instructions_read', payload: { requestId: 'w-1', agentId: 'a1', name: 'Faye' } })
      socket.handleLocalFrame('local:w', { type: 'agent_instructions_write', payload: { requestId: 'w-2', agentId: 'a1', name: 'Faye', text: 'SECRET local', version: 'x' } })
      socket.handleLocalFrame('local:w', { type: 'machine_resources', payload: { requestId: 'w-3' } })
      const { ask, replied } = relayed(true)
      await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
      await vi.waitFor(() => expect(replied()).toHaveLength(1), SETTLED)
      await vi.waitFor(() => expect(frames.map((frame) => frame.type)).toEqual(expect.arrayContaining(['agent_instructions_read_result', 'agent_instructions_write_result', 'machine_resources_result'])), SETTLED)
      // The log works for any other request, so the silence above is the exclusion and not a broken spy.
      const types = logged.mock.calls.map(([, , frame]) => frame.type)
      expect(types).toEqual(expect.arrayContaining(['machine_resources', 'machine_resources_result']))
      expect(types.filter((type) => String(type).startsWith('agent_instructions_'))).toEqual([])
      expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET')
    } finally {
      env.LOG_FRAMES = wasOn
      await socket.unregisterLocalClient('local:w')
    }
  })
})
