/** Existing caller/response limits must survive the common-owner representation migration. */
import { expect, it, vi } from 'vitest'
import { createCloudAgents } from './cloud.js'
import { createQuestionPresentations } from '../questions.js'
import { cloudFactory } from '../../testing/sessionFactories.js'
import { prepareCloudPort } from '../../cloud/responses.js'
import { cloudAgentFrame, cloudHarnessIn, type CloudHarness } from '../../lib/cloudAgents.js'
import { boundedJsonBytes } from '../../lib/boundedJsonBytes.js'
import type { CloudPort } from '../api.js'

const ROW_BYTES = 192 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const renamed = '\u0001'.repeat(120)

function maximalRow(state: CloudHarness['state'], padded: 'createdAt' | 'updatedAt'): CloudHarness {
  const value = cloudHarnessIn({
    agentId: 'cloud_' + '\u0001'.repeat(74), agent: 'fo', name: 'x', state,
    activity: '\u0001'.repeat(200), repository: '\u0001'.repeat(200), branch: '\u0001'.repeat(200),
    providerStatus: { status: '\u0001'.repeat(200), detail: '\u0001'.repeat(200) },
    links: Array.from({ length: 8 }, () => ({ label: '\u0001'.repeat(80), url: 'https://' + '\u0001'.repeat(2040) })),
    messages: Number.MAX_SAFE_INTEGER, said: null, card: null, createdAt: '0', updatedAt: '0',
  })!
  // Date.parse accepts surrounding whitespace; the normalizer intentionally preserves the exact valid string.
  // This spends the remaining old row allowance on the only otherwise unbounded normalized scalar.
  value[padded] += ' '.repeat(ROW_BYTES - bytes(value))
  expect(Number.isFinite(Date.parse(value[padded]))).toBe(true)
  expect(cloudHarnessIn(value)).toEqual(value)
  expect(bytes(value)).toBe(ROW_BYTES)
  return value
}

function fixture(row: CloudHarness, held = false) {
  let release!: () => void
  const wait = new Promise<void>(done => { release = done })
  const operation = vi.fn<Parameters<typeof prepareCloudPort>[0]['rename']>(async () => {
    if (held) await wait
    return { ok: true }
  })
  const prepared = prepareCloudPort({
    create: async () => ({ ok: false, error: 'UNUSED' }), deliver: async () => ({ ok: true }),
    answer: async () => ({ ok: true }), stopHarness: async () => ({ ok: true }), rename: operation,
  })
  const envelopes: Array<{ before: CloudHarness; reply: Awaited<ReturnType<CloudPort['rename']>> }> = []
  let selected: CloudPort = { ...prepared, rename: async (id, name, before) => {
    const reply = await prepared.rename(id, name, before)
    envelopes.push({ before, reply })
    return reply
  } }
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  const owner = createCloudAgents({ ownsFactory: cloudFactory, native: () => false, port: () => selected,
    clients, questions: createQuestionPresentations(), log: () => {} })
  expect(owner.doors.publish([row])).toEqual({ ok: true })
  clients.send.mockClear(); clients.sendCommander.mockClear()
  return { owner, clients, envelopes, operation, release, replace: () => { selected = { ...selected } } }
}

it.each(['working', 'failed', 'starting', 'idle'] as const)('keeps near-limit %s rename inside the unchanged request/result guards', async state => {
  for (const padded of ['createdAt', 'updatedAt'] as const) {
    const row = maximalRow(state, padded), t = fixture(row)
    const expected = cloudAgentFrame({ ...row, name: renamed })
    expect(await t.owner.update({ agentId: row.agentId, name: renamed })).toEqual({ agent: expected })
    expect(t.operation).toHaveBeenCalledExactlyOnceWith(row.agentId, renamed, row)
    expect(t.envelopes).toHaveLength(1)
    const { before, reply } = t.envelopes[0]
    expect(Reflect.ownKeys(before)).toEqual(Object.keys(row))
    expect(bytes(before)).toBe(ROW_BYTES)
    expect(boundedJsonBytes(before, 512 * 1024)).toBe(bytes(before))
    expect(bytes(reply)).toBeLessThanOrEqual(ROW_BYTES + 32 * 1024)
    expect(boundedJsonBytes(reply, 256 * 1024)).toBe(bytes(reply))
    const event = { type: 'agent_renamed', payload: { agentId: row.agentId, name: renamed, engine: row.agent } }
    expect(t.clients.send).toHaveBeenCalledExactlyOnceWith(event)
    expect(t.clients.sendCommander).toHaveBeenCalledExactlyOnceWith(event)
  }
})

it.each(['state advances', 'owner replaced', 'port replaced'] as const)('retains the captured boundary-sized rename while %s', async change => {
  const row = maximalRow('failed', 'updatedAt'), t = fixture(row, true)
  const captured = JSON.stringify(row), pending = t.owner.update({ agentId: row.agentId, name: renamed })!
  expect(t.operation).toHaveBeenCalledOnce()
  try {
    // A new immutable publication replaces provider facts while the response operation is held.
    expect(t.owner.doors.publish([{ ...row, state: 'idle', updatedAt: '2026-11-19T01:00:00Z' }])).toEqual({ ok: true })
    if (change === 'owner replaced') {
      expect(t.owner.doors.publish([])).toEqual({ ok: true })
      expect(t.owner.doors.publish([row])).toEqual({ ok: true })
    }
    if (change === 'port replaced') t.replace()
    t.clients.send.mockClear(); t.clients.sendCommander.mockClear()
    // Mutating the caller's original object also cannot change the admitted/captured before image.
    row.links[0].label = 'Changed outside'; row.activity = 'Changed outside'
    t.release()
    const result = await pending
    expect(JSON.stringify(t.envelopes[0].before)).toBe(captured)
    if (change === 'state advances') {
      expect(result).toEqual({ agent: cloudAgentFrame({ ...JSON.parse(captured), name: renamed }) })
      expect(t.clients.send).toHaveBeenCalledOnce(); expect(t.clients.sendCommander).toHaveBeenCalledOnce()
    } else {
      expect(result).toHaveProperty('error', 'SERVICE_UNAVAILABLE')
      expect(t.clients.send).not.toHaveBeenCalled(); expect(t.clients.sendCommander).not.toHaveBeenCalled()
    }
  } finally { t.release(); await pending }
})
