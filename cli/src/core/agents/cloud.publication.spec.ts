import { answerExperimentQuery } from '../experimentQueries.js'
import { fakeCore } from '../../testing/fakeCore.js'
import type { ServiceQueryAuthority } from '../serviceLinks.js'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createCloudAgents } from './cloud.js'
import { cloudHarnessIn, type CloudHarness } from '../../lib/cloudAgents.js'
import type { TurnCardFrame } from '../api.js'

const row = (agentId: string, name = agentId): CloudHarness => ({ agentId, name, agent: 'fo', state: 'working',
  activity: null, repository: null, branch: null, links: [], messages: 1,
  createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' })
const card = (agentId: string): TurnCardFrame => ({ type: 'commander_event', agentId, dbSessionId: agentId,
  payload: { kind: 'processing', text: 'Working' } })
const hash = (rows: CloudHarness[]) => createHash('sha256').update(JSON.stringify(rows.map(cloudHarnessIn))).digest('hex')
const setup = () => {
  const events: string[] = []
  const cloud = createCloudAgents({ port: () => null, openQuestions: new Map(), log: () => {}, clients: {
    send: frame => events.push(frame.type === 'agent_synced' ? `row:${(frame.payload.agent as { id: string }).id}` : `delete:${frame.payload.agentId}`),
    sendCommander: frame => { if (frame.type === 'commander_event') events.push(`card:${frame.agentId}`) },
    sendLocal: () => {},
  } })
  return { cloud, events }
}

it('acknowledges admission and reads back only a fingerprint of the existing accepted owner image', () => {
  const { cloud } = setup()
  expect(cloud.doors.checkpoint()).toBe(hash([]))
  expect(cloud.doors.publish([row('cloud_a')], [card('cloud_a')])).toEqual({ ok: true })
  expect(cloud.doors.checkpoint()).toBe(hash([row('cloud_a')]))
  expect(cloud.doors.publish([row('cloud_a', 'Renamed')])).toEqual({ ok: true })
  expect(cloud.doors.checkpoint()).toBe(hash([row('cloud_a', 'Renamed')]))
  expect(cloud.doors.publish([])).toEqual({ ok: true })
  expect(cloud.doors.checkpoint()).toBe(hash([]))
})

it('refuses a malformed batch truthfully without changing the accepted rows or emitting anything', () => {
  const { cloud, events } = setup()
  cloud.doors.publish([row('cloud_existing')])
  events.length = 0
  expect(cloud.doors.publish([row('cloud_a')], [card('cloud_foreign')]))
    .toEqual({ ok: false, error: 'CLOUD_PUBLICATION_INVALID' })
  expect(cloud.frames().map(frame => frame.id)).toEqual(['cloud_existing'])
  expect(events).toEqual([])
})

it('keeps each changed row and card together before deleted rows', () => {
  const { cloud, events } = setup()
  cloud.doors.publish([row('cloud_gone')])
  events.length = 0
  cloud.doors.publish([row('cloud_a'), row('cloud_b')], [card('cloud_b'), card('cloud_a')])
  expect(events).toEqual(['row:cloud_a', 'card:cloud_a', 'row:cloud_b', 'card:cloud_b', 'delete:cloud_gone'])
})

it.each([
  ['malformed row', [row('cloud_new'), { agentId: 'bad' }]],
  ['duplicate owner', [row('cloud_new'), { ...row('cloud_new'), name: 'Duplicate' }]],
  ['normalized duplicate', [row('cloud_new'), row(' cloud_new ')]],
  ['non-list', 'invalid'],
] as const)('refuses a %s through the real IPC dispatcher before replacing accepted owners', async (_reason, rows) => {
  const { cloud, events } = setup()
  cloud.doors.publish([row('cloud_existing')])
  events.length = 0
  const result = await answerExperimentQuery(fakeCore({ cloud: cloud.doors }), new Set(['cloud']), 'cloud',
    'cloud_publish', { harnesses: rows, cards: [] }, undefined, { current: () => true } as ServiceQueryAuthority)
  expect(result).toEqual({ ok: false, error: 'CLOUD_PUBLICATION_INVALID' })
  expect(cloud.frames().map(frame => frame.id)).toEqual(['cloud_existing'])
  expect(events).toEqual([])
})
