import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type TerminalWatchOutput } from '../core/api.js'
import { b64d, b64e, newEphemeral, newIdentity, welcomeSig } from '../lib/e2ee/core.js'
import type { RegisteredSession } from '../lib/registry.js'
import { observerContext, recipientHandshake } from '../sharing/crypto.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SHARE_REQUESTS, startSharing, viewerPage, watchStreams } from './sharing.js'

const identity = newIdentity()
const agent = { agentId: 'agent', sessionId: 's', engine: 'codex', active: true } as unknown as RegisteredSession

describe('Share, as a service', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'sharing-service-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  const start = (over: Parameters<typeof fakeCore>[0] = {}) => {
    const outputs: Array<(viewer: string, output: TerminalWatchOutput) => void> = []
    const watch = { frame: vi.fn(async () => {}), close: vi.fn(async () => {}), onOutput: vi.fn((listener: (viewer: string, output: TerminalWatchOutput) => void) => { outputs.push(listener); return () => {} }) }
    const sent: Array<{ connId: string; type: string; payload: any }> = []
    const viewers = { watch: vi.fn((_id: string, send: (frame: Record<string, unknown>) => void) => { send({ state: 'live' }); return vi.fn() }), stop: vi.fn() }
    const core = fakeCore({
      dataDir,
      terminals: { watch },
      agents: {
        resolve: (id: string) => { if (id === 'explode') throw new Error('the registry could not be read'); return id === 'agent' ? agent : undefined },
        dsh: () => ({ viewerUrl: 'http://127.0.0.1:7/' } as never),
      },
      account: {
        observerKey: {
          publicKey: async () => b64e(identity.pub),
          signWelcome: async (machineId, shareId, peer, ephemeral) => b64e(welcomeSig(identity.priv, observerContext(machineId, shareId), b64d(peer), b64d(ephemeral))),
        },
        backend: vi.fn(async () => ({ status: 200, body: {} })),
      },
      clients: { observer: vi.fn((connId: string, type: string, payload: Record<string, unknown>) => { sent.push({ connId, type, payload }); return true }) },
      daemon: { command: 'harness', port: 1, machineId: () => 'machine', autonomousEnv: 'staging' },
    })
    const ports = emptyPorts()
    const requests = startSharing(core, ports, { viewers })
    return { core, ports, port: ports.sharing!, requests, watch, outputs, sent, viewers }
  }

  it('answers its requests, as the socket did, and says Share is unavailable when one fails outright', async () => {
    const { requests, core } = start()
    expect(Object.keys(requests)).toEqual([...SHARE_REQUESTS])
    const asker = { local: true, owner: true }
    const linked = await requests.harness_share_link({ agentId: 'agent', visibility: 'public' }, asker) as { link: { url: string } }
    // The link names the owner's key the gateway holds, and the account's environment.
    expect(linked.link.url).toContain(`key=${encodeURIComponent(b64e(identity.pub))}`)
    expect(linked.link.url).toContain('env=staging')
    expect(core.account.backend).toHaveBeenCalledWith('PUT', expect.stringMatching(/^\/api\/harness-links\//), expect.objectContaining({ visibility: 'public' }))
    vi.mocked(core.account.backend).mockRejectedValueOnce(new Error('offline'))
    expect(await requests.harness_share_list({ agentId: 'nobody' }, asker)).toMatchObject({ error: 'HARNESS_NOT_FOUND' })
    expect(await requests.harness_share_list({ agentId: 'explode' }, asker)).toEqual({ error: 'SHARING_UNAVAILABLE', detail: 'Sharing is temporarily unavailable. Try again.' })
  })

  it('welcomes an observer with a signature the gateway made, and seals what the core\'s streams show it', async () => {
    const { requests, port, watch, outputs, sent, viewers } = start()
    const linked = await requests.harness_share_link({ agentId: 'agent', visibility: 'public' }, { local: true, owner: true }) as { link: { id: string } }
    const ephemeral = newEphemeral()
    await port.observer('observer:ken', 'observer_open', { linkId: linked.link.id, ephemeral: b64e(ephemeral.pub), authorId: 'u1', authorName: 'Ken' })
    const welcome = sent.find((frame) => frame.type === 'observer_welcome')!
    const cipher = recipientHandshake(ephemeral, 'machine', linked.link.id, b64e(identity.pub), welcome.payload)
    await port.observer('observer:ken', 'observer_frame', cipher.seal({ type: 'terminal_open', payload: { agentId: 'agent', requestId: 'r1' } }) as never)
    expect(watch.frame).toHaveBeenCalledWith('observer:ken', 'terminal_open', { agentId: 'agent', requestId: 'r1' })
    for (const listener of outputs) {
      listener('observer:ken', { type: 'terminal_opened', payload: { streamId: 's' } })
      listener('observer:ken', { binary: 'aGk=' })
    }
    const shown = sent.filter((frame) => frame.type === 'observer_frame').map((frame) => cipher.open(frame.payload))
    expect(shown).toEqual([{ type: 'terminal_opened', payload: { streamId: 's' } }, { type: 'observer_binary', payload: { bytes: 'aGk=' } }])
    // Its viewer, captured where Share runs, from the agent's viewer the core shows.
    await port.observer('observer:ken', 'observer_frame', cipher.seal({ type: 'observer_viewer', payload: {} }) as never)
    expect(viewers.watch).toHaveBeenCalledWith('agent', expect.any(Function))
    port.linkDown()
    expect(watch.close).toHaveBeenCalledWith('observer:ken')
    await port.stop()
    expect(viewers.stop).toHaveBeenCalledOnce()
  })

  it('reads its viewers\' pages from the core\'s agents, and starts a pool of its own when given none', async () => {
    const core = fakeCore({ dataDir, agents: { resolve: (id: string) => (id === 'agent' ? agent : undefined), dsh: (session) => (session === agent ? { viewerUrl: 'http://127.0.0.1:7/' } as never : null) } })
    const page = viewerPage(core)
    expect(page('agent')).toBe('http://127.0.0.1:7/')
    expect(page('nobody')).toBeNull()
    const ports = emptyPorts()
    startSharing(core, ports)
    await ports.sharing!.stop()
    expect(viewerPage(fakeCore({ agents: { resolve: () => agent, dsh: () => null } }))('agent')).toBeNull()
  })

  it('hands the owner the core\'s streams: frames to the core, what each viewer is shown back to it', async () => {
    const outputs: Array<(viewer: string, output: TerminalWatchOutput) => void> = []
    const stopHearing = vi.fn()
    const watch = { frame: vi.fn(async () => {}), close: vi.fn(async () => {}), onOutput: vi.fn((listener: (viewer: string, output: TerminalWatchOutput) => void) => { outputs.push(listener); return stopHearing }) }
    const sendTarget = vi.fn(() => true)
    const streams = watchStreams(watch, { sendTarget })
    expect(await streams.handleFrame('v', 'terminal_ack', {})).toBe(true)
    await streams.closeConnection('v')
    expect(watch.close).toHaveBeenCalledWith('v')
    outputs[0]('v', { binary: 'aGk=' })
    outputs[0]('v', { type: 'terminal_closed', payload: {} })
    expect(sendTarget.mock.calls).toEqual([['v', 'observer_binary', { bytes: 'aGk=' }], ['v', 'terminal_closed', {}]])
    await streams.stop()
    expect(stopHearing).toHaveBeenCalledOnce()
  })
})
