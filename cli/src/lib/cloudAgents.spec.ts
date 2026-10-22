import { describe, expect, it } from 'vitest'
import { CLOUD_AGENT_IDS, cloudAgentFrame, cloudHarnessIn, isCloudAgent, type CloudHarness } from './cloudAgents.js'

const harness: CloudHarness = {
  agentId: 'cloud_1', agent: 'devin-cloud', name: 'fix it', state: 'working', activity: null, repository: 'acme/api', branch: 'devin/fix',
  links: [{ label: 'Pull request #42', url: 'https://github.com/acme/api/pull/42' }], messages: 3, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:05:00.000Z',
}

describe('cloud agents', () => {
  it('are never engines, and are named by the Naming System\'s rule', () => {
    expect(CLOUD_AGENT_IDS).toEqual(['fo', 'devin-cloud', 'cursor-cloud'])
    expect(isCloudAgent('devin-cloud')).toBe(true)
    expect(isCloudAgent('devin')).toBe(false)
    expect(isCloudAgent('toString')).toBe(false)
  })

  it('keep nothing of a reported harness they cannot read', () => {
    expect(cloudHarnessIn(harness)).toEqual({ ...harness, said: null })
    // Its last words, kept to what the dial's longest card can use.
    expect(cloudHarnessIn({ ...harness, said: `  ${'a'.repeat(5_000)}` })!.said).toHaveLength(4_000)
    expect(cloudFrameHasNoWords()).toBe(true)
    for (const bad of [null, 'x', { ...harness, agentId: 'a1' }, { ...harness, agent: 'claude' }, { ...harness, state: 'odd' }, { ...harness, createdAt: 'never' }]) expect(cloudHarnessIn(bad)).toBeNull()
    expect(cloudHarnessIn({ ...harness, name: '', activity: 5, repository: '', links: [{ label: 'x', url: 'http://no' }, { url: 'https://a' }, null], messages: -1 }))
      .toMatchObject({ name: 'Devin Cloud', activity: null, repository: null, links: [], messages: 0 })
    expect(cloudHarnessIn({ ...harness, links: 'x', messages: 1.5 })).toMatchObject({ links: [], messages: 0 })
    // An older harness has no maker status. A bad one is dropped or cut down, and the harness still stands.
    expect(cloudHarnessIn(harness)).not.toHaveProperty('providerStatus')
    expect(cloudHarnessIn({ ...harness, providerStatus: 'nope' })).toEqual({ ...harness, said: null })
    expect(cloudHarnessIn({ ...harness, providerStatus: ['suspended'] })).toEqual({ ...harness, said: null })
    expect(cloudHarnessIn({ ...harness, providerStatus: { status: ` ${'s'.repeat(400)}`, detail: 3 } })!.providerStatus)
      .toEqual({ status: 's'.repeat(200), detail: null })
    expect(cloudHarnessIn({ ...harness, providerStatus: { status: 'suspended', detail: null } })!.providerStatus)
      .toEqual({ status: 'suspended', detail: null })
  })

  // What it said stays in the core: the apps read the whole conversation.
  const cloudFrameHasNoWords = (): boolean => !JSON.stringify(cloudAgentFrame({ ...harness, said: 'secret words' })).includes('secret words')

  it('travel as an agent\'s frame with no pane, its repository as its project', () => {
    expect(cloudAgentFrame(harness)).toMatchObject({
      id: 'cloud_1', sessionId: 'cloud_1', name: 'fix it', status: 'active', engine: 'devin-cloud', location: 'cloud', tmuxPane: null,
      terminal: { available: false, primary: '', runtimes: [] }, launch: { state: 'ready' }, closeSupported: false, forkable: false,
      activity: { state: 'working', validForMs: 120_000 },
      project: { kind: 'git', name: 'api', remote: 'https://github.com/acme/api', branch: 'devin/fix' },
      gitContext: { state: 'workspace' },
      cloud: { place: "Devin's cloud", state: 'working', activity: null, links: harness.links, messages: 3 },
    })
    expect(cloudAgentFrame(harness).cloud).not.toHaveProperty('providerStatus')
    expect(cloudAgentFrame({ ...harness, providerStatus: { status: 'running', detail: null } }).cloud.providerStatus)
      .toEqual({ status: 'running', detail: null })
    expect(cloudAgentFrame({ ...harness, state: 'stopped', repository: null })).toMatchObject({ status: 'stopped', project: null, gitContext: { state: 'unavailable', current: null }, activity: { state: 'idle', validForMs: 0 } })
    expect(cloudAgentFrame({ ...harness, state: 'starting' }).launch).toEqual({ state: 'starting' })
    expect(cloudAgentFrame({ ...harness, state: 'failed' }).launch).toEqual({ state: 'failed', error: 'CLOUD_FAILED', detail: 'Devin Cloud stopped with an error.' })
    expect(cloudAgentFrame({ ...harness, state: 'failed', activity: 'It reached its ACU limit.' }).launch).toMatchObject({ detail: 'It reached its ACU limit.' })
  })
})
