import { describe, expect, it } from 'vitest'
import * as store from '../parts/index.js'
import type { Part, SwarmParts } from '../parts/index.js'
import { readerView } from './views.js'
import { changesFor } from './changes.js'
import { NOW, outsider, owner, peer, richSwarm } from './fixture.test-support.js'
import type { Actor } from '../model.js'

const R = 9_000
const LATER = NOW + 5_000
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })

function scene() {
  const s = richSwarm()
  s.contribute('mac', 'swarm')
  const privateId = s.group('Peer and PM')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.userId)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.userId, generation }] }
  })
  return { s, privateId, parts: store.split(s.state, { tabId: 'tab', version: R, now: NOW }) }
}
type Kind = 'members' | 'agents' | 'groups' | 'machines' | 'starts' | 'progress'
/** A later write of one part: its version moves and `change` applies to the stored part (data, tombstone or dormant flag). */
function write(parts: SwarmParts, kind: Kind, key: string, change: (part: Part) => void): Part {
  const part = (parts[kind] as Part[]).find(p => p.key === key)!
  part.version += 1
  part.changedAt = LATER
  change(part)
  return part
}
/** What the reader receives: its view of the active (live) parts, then the changed parts run through its read check. */
function receive(parts: SwarmParts, changed: Part[], actor: Actor) {
  const active = { ...parts, ...Object.fromEntries((['members', 'agents', 'groups', 'machines', 'starts', 'progress'] as Kind[])
    .map(kind => [kind, (parts[kind] as Part[]).filter(p => !p.deleted && !p.dormant)])) } as SwarmParts
  return changesFor(readerView(active, actor, LATER, { teamMachines: [] }), changed, actor)
}
const keys = (list: Array<{ key: string }>) => list.map(p => p.key)

describe('changes since a cursor (design 4.4)', () => {
  it('sends nothing but derived when nothing changed, and the head only when it changed', () => {
    const { parts } = scene()
    expect(receive(parts, [], peer)).toMatchObject({ head: null, members: [], agents: [], groups: [], machines: [], starts: [], progress: [] })
    const head = { ...parts.head, version: R + 1, changedAt: LATER }
    parts.head = head
    expect(receive(parts, [head], peer).head).toMatchObject({ key: 'head', version: R + 1 })
  })

  it('sends a changed group whole to its readers and nothing to anyone else', () => {
    const { s, parts } = scene()
    const changed = [write(parts, 'groups', s.web, p => { (p.data as { title: string }).title = 'Web 2' }),
      write(parts, 'groups', s.secretGroup, p => { (p.data as { title: string }).title = 'Secret 2' })]
    const peerGroups = receive(parts, changed, peer).groups
    expect(peerGroups).toEqual([expect.objectContaining({ key: s.web, version: R + 1, data: expect.objectContaining({ title: 'Web 2', messageSeq: R }) })])
    expect(keys(receive(parts, changed, owner).groups)).toEqual([s.web, s.secretGroup])
  })

  it('sends a private conversation\'s change, removal and dormant stub only to its audience and the Lead', () => {
    const { s, parts, privateId } = scene()
    for (const change of [(p: Part) => { (p.data as { title: string }).title = 'x' }, (p: Part) => { p.deleted = true }, (p: Part) => { p.dormant = true }]) {
      const { parts: fresh } = scene()
      const changed = [write(fresh, 'groups', privateId, change)]
      expect(keys(receive(fresh, changed, peer).groups)).toEqual([privateId])
      expect(keys(receive(fresh, changed, agentActor(s.lead)).groups)).toEqual([privateId])
      expect(receive(fresh, changed, owner).groups).toEqual([])
      expect(receive(fresh, changed, agentActor(s.worker)).groups).toEqual([])
    }
    void parts
  })

  it('sends a removed or dormant group as a one-line stub, never its last data', () => {
    const { s, parts } = scene()
    const changed = [write(parts, 'groups', s.done, p => { p.deleted = true }), write(parts, 'groups', s.web, p => { p.dormant = true })]
    expect(receive(parts, changed, peer).groups).toEqual([
      { key: s.done, version: R + 1, changedAt: LATER, deleted: true },
      { key: s.web, version: R + 1, changedAt: LATER, dormant: true }])
  })

  it('sends an agent\'s removal only to readers of its project, and a member\'s removal to everyone', () => {
    const { s, parts } = scene()
    const secretAgent = s.add('secret-harness', s.secretGroup)
    const fresh = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const changed = [write(fresh, 'agents', secretAgent, p => { p.deleted = true }), write(fresh, 'agents', s.worker, p => { p.deleted = true }),
      write(fresh, 'members', outsider.userId, p => { p.deleted = true })]
    expect(receive(fresh, changed, peer)).toMatchObject({ agents: [{ key: s.worker, deleted: true }], members: [{ key: outsider.userId, deleted: true }] })
    expect(keys(receive(fresh, changed, owner).agents)).toEqual([secretAgent, s.worker])
    void parts
  })

  it('sends a machine whose contribution ended as a removal', () => {
    const { parts } = scene()
    const changed = [write(parts, 'machines', 'mac', p => { (p.data as { contribution: unknown }).contribution = null })]
    expect(receive(parts, changed, peer).machines).toEqual([{ key: 'mac', version: R + 1, changedAt: LATER, deleted: true }])
  })

  it('sends a start\'s removal only to readers of its group', () => {
    const { s } = scene()
    s.edit(state => {
      state.starts = [s.web, s.secretGroup].map(conversationId => ({ id: `start-${conversationId}`, creationId: 'c', actorKey: 'person:owner',
        contributorId: owner.userId, membershipGeneration: 'tab', machineOwnerId: owner.userId, hostGrant: null, harnessId: null, dispatched: false, error: null,
        request: { conversationId, machineId: 'mac', engine: 'codex', name: 'Builder', cwd: '/repo', worktree: false,
          requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }))
    })
    const fresh = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const changed = [write(fresh, 'starts', `start-${s.web}`, p => { p.deleted = true }), write(fresh, 'starts', `start-${s.secretGroup}`, p => { p.deleted = true })]
    expect(keys(receive(fresh, changed, peer).starts)).toEqual([`start-${s.web}`])
    expect(keys(receive(fresh, changed, owner).starts)).toEqual([`start-${s.web}`, `start-${s.secretGroup}`])
  })

  it('sends changed project progress only to readers of the project', () => {
    const { s } = scene()
    s.edit(state => { for (const p of state.projects!) p.progress = { since: 1, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {} } })
    const fresh = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const changed = [write(fresh, 'progress', 'lead', () => {}), write(fresh, 'progress', s.secret, () => {})]
    expect(receive(fresh, changed, peer).progress).toEqual([{ key: 'lead', version: R + 1, changedAt: LATER,
      data: { since: 1, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {}, requestedAt: null } }])
  })

  it('hands a reader only the required machines they see, whole and in changes', () => {
    const { s } = scene()
    // Only an agent of the private project runs on 'secret-mac', so the peer does not see that machine.
    s.add('secret-harness', s.secretGroup, false, owner, 'secret-mac')
    s.run({ type: 'work.define', conversationId: s.done, task: { goal: 'Check the device', changes: 'None', constraints: 'None', owns: ['devices'],
      requires: { machines: ['secret-mac', 'mac'] } }, checks: [{ description: 'It answers.', independent: false }] })
    const fresh = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const requires = (groups: Array<{ key: string }>) => (groups.find(g => g.key === s.done) as unknown as { data: { task: { requires: unknown } } }).data.task.requires
    expect(requires(readerView(fresh, owner, LATER, { teamMachines: [] }).parts.groups)).toEqual({ machines: ['secret-mac', 'mac'] })
    expect(requires(readerView(fresh, peer, LATER, { teamMachines: [] }).parts.groups)).toEqual({ machines: ['mac'], unseenMachines: 1 })
    const changed = [write(fresh, 'groups', s.done, () => {})]
    expect(requires(receive(fresh, changed, peer).groups)).toEqual({ machines: ['mac'], unseenMachines: 1 })
    expect(requires(receive(fresh, changed, owner).groups)).toEqual({ machines: ['secret-mac', 'mac'] })
  })
})
