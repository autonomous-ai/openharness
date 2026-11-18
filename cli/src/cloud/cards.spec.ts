import { expect, it } from 'vitest'
import type { CloudHarness } from '../lib/cloudAgents.js'
import { createCloudCards } from './cards.js'

const row = (over: Partial<CloudHarness> = {}): CloudHarness => ({
  agentId: 'cloud_a', agent: 'fo', name: 'Fixture', state: 'working', activity: null,
  repository: null, branch: null, links: [], messages: 1,
  createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', ...over,
})

it('restores busy tiles on reconnect without replaying finished notifications', () => {
  const cards = createCloudCards()
  const working = row({ activity: 'Reading' })
  const initial = cards([working])
  expect(initial).toEqual([{ type: 'commander_event', agentId: 'cloud_a', dbSessionId: 'cloud_a',
    payload: { kind: 'processing', text: 'Reading' } }])
  expect(cards([working])).toEqual([])
  expect(cards([working], true)).toEqual(initial)
  const done = row({ state: 'idle', said: 'Finished', card: { recap: 'Finished', text: 'Result' } })
  expect(cards([done])).toMatchObject([{ payload: { kind: 'summary', notification: { id: 'cloud_a:1', kind: 'done' } } }])
  expect(cards([done], true)).toEqual([])
  expect(cards([done])).toEqual([])
})

it('drops removed owners and treats returning answers as history', () => {
  const cards = createCloudCards()
  const done = row({ state: 'idle', said: 'Old answer', card: { recap: 'Old', text: 'Answer' } })
  expect(cards([done])).toEqual([])
  expect(cards([])).toEqual([])
  expect(cards([done])).toEqual([])
  expect(cards([row({ state: 'stopped', said: 'New answer' })])).toEqual([])
  expect(cards([row({ state: 'starting' })])).toMatchObject([{ payload: { kind: 'processing' } }])
  expect(cards([row({ state: 'failed', activity: 'Stopped' })])).toMatchObject([{ payload: { kind: 'error', text: 'Stopped' } }])
})
