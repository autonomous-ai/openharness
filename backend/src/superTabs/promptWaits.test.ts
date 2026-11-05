import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import * as store from './parts/index.js'
import { readerView } from './read/views.js'
import { NOW, outsider, owner, peer, richSwarm } from './read/fixture.test-support.js'
import { promptWaits } from './promptWaits.js'
import type { Actor } from './model.js'
import { agentDisplayName } from './agentNames.js'

/** A task's agent at a prompt: the alert its own host sends (terminal.ts terminalAlert), and its end. */
const host = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })
const prompt = (agentId: string, active = true): Command => ({ type: 'agent.alert', agentId, alert: 'prompt', active })

function scene() {
  const s = richSwarm()
  const alert = (agentId: string, active = true) => applyCommand(s.state, host(agentId), prompt(agentId, active), { now: NOW, operationId: `alert-${agentId}-${active}` })
  const send = (agentId: string, active = true) => { const effects = alert(agentId, active); s.edit(state => Object.assign(state, effects.state)); return effects }
  return Object.assign(s, { send })
}

describe('a task agent waiting at a prompt (task #3029)', () => {
  it('reaches the task\'s requester under Decisions, still tells the PM, and clears when the agent moves on', () => {
    const s = scene()
    s.run({ type: 'conversation.requester', conversationId: s.web, personId: peer.userId })
    expect(promptWaits(s.state, peer)).toEqual([])
    const effects = s.send(s.worker)
    // The PM's row is as before: in the task, delivered to the PM.
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: s.web, recipients: [s.lead],
      source: { kind: 'terminal-alert', agentId: s.worker, alert: 'prompt' } })])
    expect(promptWaits(s.state, peer)).toEqual([{ agentId: s.worker, agentName: agentDisplayName(s.state.agents, s.worker), conversationId: s.web, conversationTitle: 'Web',
      projectId: s.state.projects![0]!.id, projectName: s.state.projects![0]!.name }])
    s.send(s.worker, false)
    expect(promptWaits(s.state, peer)).toEqual([])
  })

  it('tells only the task\'s own people: not other members, not the machine\'s owner without a device, not a reader the task is closed to', () => {
    const s = scene()
    s.run({ type: 'conversation.requester', conversationId: s.web, personId: peer.userId })
    s.send(s.worker)
    expect(promptWaits(s.state, outsider)).toEqual([])
    expect(promptWaits(s.state, owner)).toEqual([])
    // A requester who no longer reads the task's project is told nothing of it.
    s.edit(state => { const web = state.conversations.find(c => c.id === s.web)!; web.projectId = s.secret })
    expect(promptWaits(s.state, peer)).toEqual([])
  })

  it('reaches the machine\'s owner when the task needs a device on that machine', () => {
    const s = scene()
    const bench = s.group('Flash the board')
    const flasher = s.add('flasher', bench, false, peer, 'peer-mac', peer.userId)
    s.run({ type: 'work.assign', conversationId: bench, agentId: flasher })
    s.edit(state => {
      const agent = state.agents.find(a => a.id === flasher)!
      agent.alerting = ['prompt']
    })
    // No device: the machine's owner is not the task's person.
    expect(promptWaits(s.state, peer)).toEqual([])
    s.edit(state => { const task = state.conversations.find(c => c.id === bench)!; task.task = { ...task.task!, requires: { devices: ['/dev/cu.usbmodem1'] } } })
    expect(promptWaits(s.state, peer).map(w => w.agentId)).toEqual([flasher])
    // A device on another machine is not this machine's owner's to handle.
    s.edit(state => { const task = state.conversations.find(c => c.id === bench)!; task.task = { ...task.task!, requires: { machines: ['host'], devices: ['/dev/cu.usbmodem1'] } } })
    expect(promptWaits(s.state, peer)).toEqual([])
  })

  it('reaches the requester of the task a step reviews, and nobody for an agent with no task', () => {
    const s = scene()
    s.run({ type: 'conversation.requester', conversationId: s.web, personId: peer.userId })
    const review = s.run({ type: 'conversation.create', title: 'Review Web', brief: 'Review it.', checks: [], reviewOf: s.web }).conversationId as string
    const reviewer = s.add('reviewer', review)
    s.run({ type: 'work.assign', conversationId: review, agentId: reviewer })
    s.send(reviewer)
    expect(promptWaits(s.state, peer).map(w => [w.agentId, w.conversationId])).toEqual([[reviewer, review]])
    // The Lead has no task: its prompt stays the PM's own business.
    s.send(s.lead)
    expect(promptWaits(s.state, peer).map(w => w.agentId)).toEqual([reviewer])
  })

  it('is in a person\'s read view, and in no agent\'s', () => {
    const s = scene()
    s.run({ type: 'conversation.requester', conversationId: s.web, personId: peer.userId })
    s.send(s.worker)
    const parts = store.split(s.state, { tabId: 'tab', version: 9_000, now: NOW })
    expect(readerView(parts, peer, NOW, { teamMachines: [] }).derived.promptsWaiting).toEqual([expect.objectContaining({ agentId: s.worker, conversationId: s.web })])
    expect(readerView(parts, outsider, NOW, { teamMachines: [] }).derived.promptsWaiting).toEqual([])
    expect(readerView(parts, host(s.lead), NOW, { teamMachines: [] }).derived).not.toHaveProperty('promptsWaiting')
  })
})
