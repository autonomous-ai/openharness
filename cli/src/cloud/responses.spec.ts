import { expect, it, vi } from 'vitest'
import { prepareCloudPort } from './responses.js'
import { cloudAgentFrame, cloudPresentation, type CloudHarness } from '../lib/cloudAgents.js'

const owner: CloudHarness = { agentId: 'cloud_1', agent: 'fo', name: 'Original', state: 'working', activity: null,
  repository: null, branch: null, links: [], messages: 0, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:00:00Z' }
const setup = (result: unknown) => {
  const operation = vi.fn(async () => result)
  return { operation, port: prepareCloudPort({ create: operation, deliver: operation, answer: operation, rename: operation, stopHarness: operation } as never) }
}
it('prepares each existing public result without retaining internal ok/detail fields', async () => {
  const t = setup({ ok: true, agent: cloudAgentFrame(owner), detail: 'done' })
  expect(await t.port.create({})).toEqual({ agent: cloudAgentFrame(owner) })
  expect(await t.port.deliver(owner.agentId, 'words')).toEqual({ ok: true, agent: cloudAgentFrame(owner), detail: 'done' })
  expect(await t.port.answer(owner.agentId, 'cloud_q_1', {})).toEqual({ ok: true })
  expect(await t.port.stopHarness(owner.agentId)).toEqual({ deleted: true, detail: 'done' })
  expect(await setup({ ok: true }).port.stopHarness(owner.agentId)).toEqual({ deleted: true })
  const renamed = await t.port.rename(owner.agentId, ' Renamed ', cloudPresentation(owner))
  expect(renamed).toEqual({ agent: cloudAgentFrame({ ...owner, name: 'Renamed' }), renamed: { type: 'agent_renamed', payload: { agentId: owner.agentId, name: 'Renamed', engine: owner.agent } } })
})
it('keeps stale-question naming and maps every other answer failure, preserving empty details', async () => {
  for (const detail of [undefined, '', 'refused']) {
    for (const error of ['STALE_QUESTION', 'BUSY']) {
      const t = setup({ ok: false, error, ...(detail === undefined ? {} : { detail }) })
      const expected = { error, ...(detail ? { detail } : {}) }
      expect(await t.port.create({})).toEqual(expected)
      expect(await t.port.rename(owner.agentId, 'Renamed', cloudPresentation(owner))).toEqual(expected)
      expect(await t.port.stopHarness(owner.agentId)).toEqual(expected)
      expect(await t.port.answer(owner.agentId, 'cloud_q_1', {})).toEqual({ ok: false, error: error === 'STALE_QUESTION' ? error : 'ANSWER_FAILED', detail: detail ?? '' })
    }
  }
})
it('rejects invalid or over-limit captured rows before invoking rename', async () => {
  for (const before of [undefined, null, {}, { ...cloudPresentation(owner), id: 'cloud_other' }, { ...cloudPresentation(owner), app: { data: 'x'.repeat(512 * 1024) } }]) {
    const t = setup({ ok: true })
    expect(await t.port.rename(owner.agentId, 'Renamed', before as never)).toEqual({ error: 'CLOUD_RESPONSE_INVALID' })
    expect(t.operation).not.toHaveBeenCalled()
  }
})
