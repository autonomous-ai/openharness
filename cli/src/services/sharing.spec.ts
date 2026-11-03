import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type TerminalWatchOutput } from '../core/api.js'
import { b64d, b64e, newEphemeral, newIdentity, sign, welcomeSig } from '../lib/e2ee/core.js'
import { encodeRoster, rosterBytes, type Roster } from '../messages/roster.js'
import { RosterStore } from '../messages/rosterStore.js'
import { ConsentStore } from '../messages/consentStore.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import type { RegisteredSession } from '../lib/registry.js'
import { observerContext, recipientHandshake } from '../sharing/crypto.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SHARE_REQUESTS, shareObservers, startSharing, viewerPage, watchStreams } from './sharing.js'
import { observerSource, publishObservers } from '../superTabs/observers.js'

const identity = newIdentity()
const agent = { agentId: 'agent', sessionId: 's', engine: 'codex', active: true } as unknown as RegisteredSession

// HARNESS_SWARM=off: Share's process hands in no Swarm. Its observers then watch nothing, invitations kept as for a host
// that stalled, and a session a roster marked confidential still refuses every share (sharing/swarmMarks.ts).
describe('who a Super Tab lets watch a harness here', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'sharing-observers-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })
  const core = () => fakeCore({ dataDir, daemon: { command: 'harness', port: 1, machineId: () => 'machine' } })
  const grant = (agentId: string, tab?: string) => ({ agentId, recipientEmail: 'b@example.com', ...(tab ? { tab } : {}) }) as never

  it('is the Swarm\'s roster while it is on, and with it off, none of a Super Tab\'s and no confidential session\'s', () => {
    publishObservers(dataDir, 'machine', [{ tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine' }, observers: [{ email: 'b@example.com' }] },
      { tabId: 'tab', confidential: true, agent: { harnessId: 'lead', machineId: 'machine' }, observers: [] }], Date.now() + 5_000)
    const on = shareObservers(core(), observerSource)
    expect(on.known()).toEqual([expect.objectContaining({ tab: 'super:tab', agentId: 'member', email: 'b@example.com' })])
    expect(on.allows(grant('member', 'super:tab'))).toBe(true)
    expect(on.allows(grant('lead'))).toBe(false)
    expect(on.allows(grant('ordinary'))).toBe(true)
    expect(on.paused(grant('member', 'super:tab'))).toBe(false)
    const off = shareObservers(core())
    expect(off.known()).toBeNull()
    expect(off.allows(grant('member', 'super:tab'))).toBe(false)
    expect(off.allows(grant('lead'))).toBe(false)
    expect(off.allows(grant('ordinary'))).toBe(true)
    expect(off.paused(grant('member', 'super:tab'))).toBe(false)
  })
})

describe('Share, as a service', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'sharing-service-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); signedOutForTest() })

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
        ...over.account,
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

  it('derives its observers from the shared tabs Agent Messages holds here, read only, for the account signed in', async () => {
    setAgentSettingsForTest(dataDir, { agentMessages: true })
    const tabOwner = newIdentity(), TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6', dir = join(dataDir, 'agent-messages')
    const file = join(dir, 'shared-tabs.json'), consentFile = join(dir, 'shared-tabs-consent.json')
    let version = 0
    const roster = (members: string[]): Roster => ({ sharedTabId: TAB, version, name: 'app',
      owner: { accountId: 'u-alice', email: 'alice@x.io', machineId: 'alice-mac', machinePublicKey: b64e(tabOwner.pub) }, leader: null,
      members: ['u-bob', ...members].map((id) => ({ accountId: id, email: `${id.slice(2)}@x.io`, name: id, acceptedAt: '2026-10-15T00:00:00.000Z' })),
      harnesses: [{ accountId: 'u-bob', machineId: 'machine', machinePublicKey: b64e(identity.pub), agentId: 'agent', name: 'api', engine: 'codex' }], invites: [] })
    const hold = (members: string[]) => {
      const rosters = new RosterStore(file)
      rosters.pin(TAB, b64e(tabOwner.pub))
      version++
      const body = encodeRoster(roster(members))
      rosters.offer({ body, signature: b64e(sign(tabOwner.priv, rosterBytes(TAB, version, body))) })
    }
    let account: { accountId: string; email: string } | null = { accountId: 'u-bob', email: 'bob@x.io' }
    const { requests, core } = start({ account: { identity: async () => account } })
    const asker = { local: true, owner: true }
    const derive = async () => { const answer = await requests.harness_share_rosters({}, asker); for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0)); return answer }
    const shared = () => vi.mocked(core.account.backend).mock.calls.filter(([, path]) => path.startsWith('/api/harness-shares/')).map(([method, , body]) => [method, (body as { recipientEmail?: string } | undefined)?.recipientEmail])
    // No shared tab here yet: nothing to grant.
    expect(await derive()).toEqual({ invited: 0, revoked: 0 })
    hold(['u-carol'])
    // Listed by the owner, but never asked for from this machine: nobody watches it.
    expect(await derive()).toEqual({ invited: 0, revoked: 0 })
    new ConsentStore(consentFile).grant(TAB, 'machine', 'agent', true)
    expect(await derive()).toEqual({ invited: 2, revoked: 0 })
    expect(shared()).toEqual([['PUT', 'alice@x.io'], ['PUT', 'carol@x.io']])
    // An account the core cannot say, or a file Agent Messages has not finished writing, takes nobody's view away.
    hold([])
    account = null
    expect(await derive()).toEqual({ invited: 0, revoked: 0 })
    account = { accountId: 'u-bob', email: 'bob@x.io' }
    for (const path of [file, consentFile]) {
      const whole = readFileSync(path, 'utf8')
      writeFileSync(path, '{"tabs":')
      expect(await derive()).toEqual({ invited: 0, revoked: 0 })
      // Only read: the file is neither moved aside nor rewritten, which is the messages process's alone.
      expect(readFileSync(path, 'utf8')).toBe('{"tabs":')
      writeFileSync(path, whole)
    }
    expect(await derive()).toEqual({ invited: 0, revoked: 1 })
    expect(shared().at(-1)).toEqual(['DELETE', undefined])
    // Agent Messages off here: its rosters stop following the tabs, so every derived grant goes.
    setAgentSettingsForTest(dataDir, { agentMessages: false })
    expect(await derive()).toEqual({ invited: 0, revoked: 1 })
    setAgentSettingsForTest(dataDir, { agentMessages: true })
    expect(await derive()).toEqual({ invited: 1, revoked: 0 })
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
