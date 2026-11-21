import { cloudQuestionClose, prepareCloudQuestion } from '../cloud/questions.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runCloudService } from './cloudProcess.js'
import type { startCloudOn } from './cloud.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('cloud agents in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers the apps and the core\'s port, and tells a core that connects everything again', async () => {
    let options: ServiceProcessOptions | null = null
    const port = { create: vi.fn(async () => ({ agent: {} })), deliver: vi.fn(async () => ({ ok: true })), answer: vi.fn(async () => ({ ok: true })), rename: vi.fn(async () => ({ ok: true })), stopHarness: vi.fn(async () => ({ ok: true })) }
    const republish = vi.fn(), disconnected = vi.fn()
    let core: Parameters<typeof startCloudOn>[0] | null = null
    const start = vi.fn((given, ports) => { core = given; ports.cloud = port; return { requests: { cloud_agents: async () => ({ agents: [] }) }, republish, disconnected } }) as unknown as typeof startCloudOn
    runCloudService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't', run: (given) => { options = given; return { stop: vi.fn() } }, start })
    const requests = options!.requests
    const asker = { local: true, owner: true }
    expect(await requests.cloud_agents!({}, asker)).toEqual({ agents: [] })
    await requests.create!({ engine: 'fo' }, asker)
    await requests.deliver!({ agentId: 'cloud_1', text: 'hi' }, asker)
    await requests.deliver!({}, asker)
    await requests.answer!({ agentId: 'cloud_1', questionId: 'cloud_q_1', requestId: 'the-link-s-own', answers: { answer: 'main', bad: 3 } }, asker)
    await requests.answer!({ answers: null }, asker)
    await requests.rename!({ agentId: 'cloud_1', name: 'Trip', before: { agentId: 'cloud_1' } }, asker)
    await requests.stopHarness!({ agentId: 'cloud_1' }, asker)
    expect(port.rename).toHaveBeenCalledWith('cloud_1', 'Trip', { agentId: 'cloud_1' })
    expect(port.create).toHaveBeenCalledWith({ engine: 'fo' })
    expect(port.deliver.mock.calls).toEqual([['cloud_1', 'hi'], ['', '']])
    expect(port.answer.mock.calls).toEqual([['cloud_1', 'cloud_q_1', { answer: 'main' }], ['', '', {}]])
    expect(port.stopHarness).toHaveBeenCalledWith('cloud_1')

    // Before a core connects, what it tells the core goes nowhere; once one does, it is asked of that core.
    await expect(core!.owners!.end('transfer')).rejects.toThrow('not connected')
    const query = vi.fn(async () => ({ ok: true }))
    options!.onConnected!({ query } as unknown as CoreConnection)
    expect(republish).toHaveBeenCalled()
    await core!.owners!.end('transfer')
    await core!.owners!.ask('cloud_1', 'cloud_q_1', prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] }))
    await core!.owners!.unask('cloud_1', 'cloud_q_1', cloudQuestionClose('cloud_1', 'cloud_q_1'))
    expect(query.mock.calls).toEqual([
      ['session_owner_end', { transfer: 'transfer' }], ['session_owner_ask', { agentId: 'cloud_1', questionId: 'cloud_q_1', question: prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] }) }],
      ['session_owner_unask', { agentId: 'cloud_1', questionId: 'cloud_q_1', close: cloudQuestionClose('cloud_1', 'cloud_q_1') }],
    ])
    options!.onDisconnected!()
    expect(disconnected).toHaveBeenCalledOnce()
    await expect(core!.owners!.end('transfer')).rejects.toThrow('not connected')
  })

  it('runs as a real service by default', () => {
    runCloudService({ dataDir: '/data-cloud-spec-unused', socketPath: '/s', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({
      name: 'cloud', requests: expect.objectContaining({ cloud_transcript: expect.any(Function), cloud_send: expect.any(Function), cloud_agents: expect.any(Function), create: expect.any(Function) }),
    }))
  })
})
