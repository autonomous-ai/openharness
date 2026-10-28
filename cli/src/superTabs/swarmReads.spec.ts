import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, ok, readFixture, refused, type BackendReply } from './fixtures/read/index.js'
import { SuperTabHostError } from './host.js'
import { UPDATE_MESSAGE } from './readContract.js'
import { SwarmReads } from './swarmReads.js'

type Json = Record<string, unknown>
const T = FIXTURE.tabId, LEAD = FIXTURE.leadId
const FIRST = `/api/super-tabs/${T}/parts?asAgentId=${LEAD}`
const CHANGES = (cursor = 'eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjozfQ') => `/api/super-tabs/${T}/changes?cursor=${cursor}&asAgentId=${LEAD}`

/** A backend that answers each path from a queue of replies, in order; the last reply of a path repeats. */
function backendOf(routes: Record<string, BackendReply[]>) {
  const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => {
    const queue = routes[path]
    if (!queue?.length) return refused(500, 'UNEXPECTED', path)
    return queue.length > 1 ? queue.shift()! : queue[0]
  })
  return { call, reads: new SwarmReads(fakeCore({ account: { backend: call } })) }
}
const paths = (call: ReturnType<typeof backendOf>['call']) => call.mock.calls.map(c => c[1])
const conversations = (state: Json) => (state.conversations as Json[]).map(c => c.id)

describe('the daemon\'s Swarm reads', () => {
  it('first loads a Swarm once as the agent, then reads only what changed', async () => {
    const { call, reads } = backendOf({ [FIRST]: [ok(readFixture('parts-lead'))], [CHANGES()]: [ok(readFixture('changes-lead'))] })
    const first = await reads.read(T, LEAD)
    expect(first).toEqual({ state: readFixture<{ state: Json }>('legacy-tab-lead').state, lastChangedAt: 1793010101002, githubApp: true, teamAccounts: true })
    const next = await reads.read(T, LEAD)
    expect(conversations(next.state)).toEqual([FIXTURE.leadGroup, FIXTURE.leadsGroup, FIXTURE.workGroup])
    expect(next.lastChangedAt).toBe(1793010106120)
    expect(paths(call)).toEqual([FIRST, CHANGES()])
  })

  it('loads again in full when the server asks it to, or no longer knows the Swarm or the agent', async () => {
    for (const answer of [ok(readFixture('changes-reload')), refused(404, 'NOT_FOUND'), refused(403, 'FORBIDDEN')]) {
      const { call, reads } = backendOf({ [FIRST]: [ok(readFixture('parts-lead'))], [CHANGES()]: [answer] })
      await reads.read(T, LEAD)
      expect((await reads.read(T, LEAD)).state).toEqual(readFixture<{ state: Json }>('legacy-tab-lead').state)
      expect(paths(call)).toEqual([FIRST, CHANGES(), FIRST])
    }
  })

  it('fails as today when the first load is refused, and starts from a first load after that', async () => {
    const { call, reads } = backendOf({ [FIRST]: [refused(403, 'FORBIDDEN', 'No access'), ok(readFixture('parts-lead'))] })
    await expect(reads.read(T, LEAD)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await reads.read(T, LEAD)
    expect(paths(call)).toEqual([FIRST, FIRST])
  })

  it('keeps nothing of a Swarm whose access was taken away, so a later read never resumes from it', async () => {
    const { call, reads } = backendOf({ [FIRST]: [ok(readFixture('parts-lead')), refused(403, 'FORBIDDEN'), ok(readFixture('parts-lead'))],
      [CHANGES()]: [refused(403, 'FORBIDDEN')] })
    await reads.read(T, LEAD)
    await expect(reads.read(T, LEAD)).rejects.toMatchObject({ status: 403 })
    await reads.read(T, LEAD)
    expect(paths(call)).toEqual([FIRST, CHANGES(), FIRST, FIRST])
  })

  it('keeps what it holds when a changes read fails for another reason, and asks from the same cursor next time', async () => {
    const { call, reads } = backendOf({ [FIRST]: [ok(readFixture('parts-lead'))],
      [CHANGES()]: [refused(503, 'SWARM_BUSY', 'Busy'), ok(readFixture('changes-lead'))] })
    await reads.read(T, LEAD)
    await expect(reads.read(T, LEAD)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
    expect(conversations((await reads.read(T, LEAD)).state)).toHaveLength(3)
    expect(paths(call)).toEqual([FIRST, CHANGES(), CHANGES()])
  })

  it('tells the person to update Harness for HTTP 426 and for a format it cannot read', async () => {
    const old = backendOf({ [FIRST]: [{ status: 426, body: { success: false, error: { code: 'UPDATE_REQUIRED' } } }] })
    await expect(old.reads.read(T, LEAD)).rejects.toEqual(new SuperTabHostError('UPDATE_REQUIRED', UPDATE_MESSAGE, 426))
    const newer = backendOf({ [FIRST]: [ok({ ...readFixture<Json>('parts-lead'), format: 3 })] })
    await expect(newer.reads.read(T, LEAD)).rejects.toEqual(new SuperTabHostError('UPDATE_REQUIRED', UPDATE_MESSAGE, 426))
    const changed = backendOf({ [FIRST]: [ok(readFixture('parts-lead'))], [CHANGES()]: [ok({ ...readFixture<Json>('changes-lead'), format: 3 })] })
    await changed.reads.read(T, LEAD)
    await expect(changed.reads.read(T, LEAD)).rejects.toMatchObject({ code: 'UPDATE_REQUIRED', status: 426 })
  })

  it('reads as the person without an agent, and keeps each reader\'s view apart', async () => {
    const person = `/api/super-tabs/${T}/parts`
    const { call, reads } = backendOf({ [person]: [ok(readFixture('parts-builder'))], [FIRST]: [ok(readFixture('parts-lead'))] })
    expect(conversations((await reads.read(T)).state)).not.toContain(FIXTURE.leadsGroup)
    expect(conversations((await reads.read(T, LEAD)).state)).toContain(FIXTURE.leadsGroup)
    expect(paths(call)).toEqual([person, FIRST])
  })

  it('runs one read of a Swarm at a time, each from what the last one left', async () => {
    const { call, reads } = backendOf({ [FIRST]: [ok(readFixture('parts-lead'))], [CHANGES()]: [ok(readFixture('changes-lead'))],
      [CHANGES('eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjozfQ')]: [ok(readFixture('changes-lead'))] })
    await Promise.all([reads.read(T, LEAD), reads.read(T, LEAD), reads.read(T, LEAD)])
    expect(paths(call)).toEqual([FIRST, CHANGES(), CHANGES('eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjozfQ')])
  })

  it('holds a bounded number of Swarms, dropping the one read longest ago', async () => {
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => path.includes('/changes')
      ? ok(readFixture('changes-lead')) : ok(readFixture('parts-lead')))
    const reads = new SwarmReads(fakeCore({ account: { backend: call } }), { maxSwarms: 2 })
    for (const agent of ['a1', 'a2', 'a1', 'a3', 'a1', 'a2']) await reads.read(T, agent)
    expect(paths(call).map(p => `${p.includes('/changes') ? 'changes' : 'first'} ${p.slice(-2)}`))
      .toEqual(['first a1', 'first a2', 'changes a1', 'first a3', 'changes a1', 'first a2'])
  })
})
