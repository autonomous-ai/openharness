// A person switches their Buddy between their own subscription and a model shared in the Swarm, and back (task #2354,
// docs/plans/2026-11-03-buddy-model-switch-design.md). The server checks the model against what the Swarm serves now,
// records the request for the Buddy's machine, and writes the outcome in the person's Buddy chat only.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import type { ContributedMachine } from './machines.js'
import { swarmBuddyChatId } from './buddies.js'
import { sweepLiveness } from './liveness.js'
import { BUDDY_MODEL_LEASE_MS } from './tidy.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const third: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'third', email: 'third@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const NOW = 1000
const MODEL = 'deepseek-4.1-flash'
type Reading = NonNullable<ContributedMachine['observation']>
type LocalModel = NonNullable<Reading['localModels']>[number]
const reading = (receivedAt: number, localModels: LocalModel[] = [], capabilities = ['buddySessions', 'swarmBuddy', 'buddyModel']): Reading => ({
  generation: 'g1', receivedAt, sessionKind: 'computer',
  resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null,
    projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
  tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], capabilities, localModels })

/** A Swarm where owner's Mac Studio serves DeepSeek on the Swarm's grid and shares an API, and peer runs their one Buddy on
 *  their own Mac in the Swarm's Machines list. */
function setup(options: { buddyCapabilities?: string[] } = {}) {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  const grid = state.localModels!.grid
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' },
    { id: 'third', email: third.email, role: 'collaborator', generation: 'first' })
  state.people.find(p => p.id === 'owner')!.generation = 'owner-gen'
  const machine = (machineId: string, name: string, contributorId: string, observation: Reading): ContributedMachine => ({ machineId, name, contributorId,
    membershipGeneration: state.people.find(p => p.id === contributorId)!.generation, generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation })
  state.machines = [
    machine('owner-studio', 'Mac Studio', 'owner', reading(NOW, [
      { grid, model: MODEL, name: 'DeepSeek 4.1 Flash', contextWindow: 131072, kind: 'local' },
      { grid, model: 'gpt-6.1-sol', kind: 'api' },
      // Shared with owner on another grid: usable on owner's machine alone, never by peer's Buddy.
      { grid: 'friends-grid', model: 'qwen-coder', kind: 'shared' },
      { grid, model: 'starting-model', kind: 'local', starting: true },
    ])),
    machine('peer-mac', 'Peer Mac', 'peer', reading(NOW, [], options.buddyCapabilities)),
  ]
  let next = 0
  const run = (command: Command, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: NOW,
      contribution: { machineOwnerId: 'peer', contributorId: 'peer', hostGrant: null }, ...context })
    state = effects.state
    return effects
  }
  const added = run({ type: 'buddy.create', machineId: 'peer-mac', engine: 'claude' })
  const startId = added.result.startId as string
  const buddyId = run({ type: 'agent.started', startId, harnessId: 'peer-buddy', configuration }).result.agentId as string
  run({ type: 'agent.startSettled', startId, warning: null })
  const chat = swarmBuddyChatId({ id: 'peer', generation: 'first' })
  const buddy = (): Actor => ({ kind: 'agent', agentId: buddyId, machineOwnerId: 'peer' })
  const agent = () => state.agents.find(a => a.id === buddyId)!
  return { run, grid, chat, buddyId, buddy, agent, get state() { return state } }
}
const code = (fn: () => unknown): string | undefined => {
  try { fn() } catch (error) { return (error as { code?: string }).code }
  return undefined
}

describe('asking to switch a Buddy\'s model', () => {
  it('records the request for the Buddy\'s machine, with the window the serving machine reported', () => {
    const f = setup()
    f.run({ type: 'buddy.model', gridModel: MODEL })
    expect(f.agent().modelRequest).toMatchObject({ gridModel: MODEL, contextWindow: 131072, requestedBy: 'peer' })
  })

  it('records a request back to the subscription', () => {
    const f = setup()
    f.agent().gridModel = MODEL
    f.run({ type: 'buddy.model', gridModel: null })
    expect(f.agent().modelRequest).toMatchObject({ gridModel: null, requestedBy: 'peer' })
  })

  it('refuses a model the Swarm does not serve now: unknown, another grid\'s, still starting, or a stale reading', () => {
    for (const model of ['nothing-serves-this', 'qwen-coder', 'starting-model']) {
      const f = setup()
      expect(code(() => f.run({ type: 'buddy.model', gridModel: model }))).toBe('BUDDY_MODEL_UNAVAILABLE')
      expect(f.agent().modelRequest).toBeUndefined()
    }
    const stale = setup()
    stale.state.machines!.find(m => m.machineId === 'owner-studio')!.observation!.receivedAt = NOW - 10 * 60_000
    expect(code(() => stale.run({ type: 'buddy.model', gridModel: MODEL }))).toBe('BUDDY_MODEL_UNAVAILABLE')
    const off = setup()
    off.state.localModels!.enabled = false
    expect(code(() => off.run({ type: 'buddy.model', gridModel: MODEL }))).toBe('BUDDY_MODEL_UNAVAILABLE')
  })

  it('is its owner\'s alone: not another member, not the Swarm\'s owner, not the Buddy itself', () => {
    const f = setup()
    expect(code(() => f.run({ type: 'buddy.model', gridModel: MODEL }, third))).toBe('NO_BUDDY')
    expect(code(() => f.run({ type: 'buddy.model', gridModel: MODEL }, owner))).toBe('NO_BUDDY')
    expect(code(() => f.run({ type: 'buddy.model', gridModel: MODEL }, f.buddy()))).toBe('BUDDY_FORBIDDEN')
    expect(f.agent().modelRequest).toBeUndefined()
  })

  it('refuses a second switch while one is under way', () => {
    const f = setup()
    f.run({ type: 'buddy.model', gridModel: MODEL })
    expect(code(() => f.run({ type: 'buddy.model', gridModel: null }))).toBe('BUDDY_SWITCHING')
  })

  it('refuses a Buddy machine whose Harness cannot switch, one gone quiet, and one outside the Swarm\'s Machines', () => {
    const old = setup({ buddyCapabilities: ['buddySessions', 'swarmBuddy'] })
    expect(code(() => old.run({ type: 'buddy.model', gridModel: MODEL }))).toBe('HOST_OUTDATED')
    const quiet = setup()
    quiet.state.machines!.find(m => m.machineId === 'peer-mac')!.observation!.receivedAt = NOW - 10 * 60_000
    expect(code(() => quiet.run({ type: 'buddy.model', gridModel: MODEL }))).toBe('MACHINE_OFFLINE')
    const only = setup()
    only.state.machines!.find(m => m.machineId === 'peer-mac')!.buddyOnly = true
    expect(code(() => only.run({ type: 'buddy.model', gridModel: MODEL }))).toBe('BUDDY_MODEL_MACHINE')
  })
})

describe('the Buddy\'s machine reporting the switch', () => {
  const asked = (gridModel: string | null = MODEL) => {
    const f = setup()
    f.run({ type: 'buddy.model', gridModel })
    return { f, requestId: f.agent().modelRequest!.id }
  }

  it('lands the Buddy on the model and tells its owner, in their Buddy chat alone, who serves it', () => {
    const { f, requestId } = asked()
    const effects = f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId, ok: true }, f.buddy())
    expect(f.agent().gridModel).toBe(MODEL)
    expect(f.agent().modelRequest).toBeUndefined()
    expect(effects.messages.map(m => [m.conversationId, m.text])).toEqual([
      [f.chat, 'Your Buddy now runs on DeepSeek 4.1 Flash, served by Mac Studio.']])
  })

  it('says when the conversation was too long and the Buddy started fresh', () => {
    const { f, requestId } = asked()
    const effects = f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId, ok: true, fresh: true }, f.buddy())
    expect(effects.messages.map(m => m.text)).toEqual(['Your Buddy started a fresh session on DeepSeek 4.1 Flash: this conversation is too long '
      + 'for it (128K). Switch back to your subscription to continue the earlier one.'])
  })

  it('names a saved API by the member who shares it', () => {
    const f = setup()
    f.run({ type: 'buddy.model', gridModel: 'gpt-6.1-sol' })
    const effects = f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId: f.agent().modelRequest!.id, ok: true }, f.buddy())
    expect(effects.messages.map(m => m.text)).toEqual(["Your Buddy now runs on gpt-6.1-sol, owner@example.com's saved API."])
  })

  it('brings the Buddy back to the subscription', () => {
    const f = setup()
    f.agent().gridModel = MODEL
    f.run({ type: 'buddy.model', gridModel: null })
    const effects = f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId: f.agent().modelRequest!.id, ok: true }, f.buddy())
    expect(f.agent().gridModel).toBeUndefined()
    expect(effects.messages.map(m => m.text)).toEqual(['Your Buddy is back on your subscription.'])
  })

  it('leaves the Buddy where it was on a failure, and says why', () => {
    const { f, requestId } = asked()
    const effects = f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId, ok: false,
      error: 'Your Buddy is answering. Try again when it has finished.\n' }, f.buddy())
    expect(f.agent().gridModel).toBeUndefined()
    expect(f.agent().modelRequest).toBeUndefined()
    expect(effects.messages.map(m => m.text)).toEqual([
      "Couldn't switch your Buddy: Your Buddy is answering. Try again when it has finished. It is still on your subscription."])
  })

  it('refuses a result for another request, and from any agent but the Buddy itself', () => {
    const { f, requestId } = asked()
    expect(code(() => f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId: 'not-it', ok: true }, f.buddy()))).toBe('STALE_SWITCH')
    const pm: Actor = { kind: 'agent', agentId: 'someone-else', machineOwnerId: 'peer' }
    expect(code(() => f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId, ok: true }, pm))).not.toBeUndefined()
    expect(code(() => f.run({ type: 'buddy.modelResult', agentId: f.buddyId, requestId, ok: true }, peer))).not.toBeUndefined()
    expect(f.agent().gridModel).toBeUndefined()
  })

  it('drops a request nobody answered within its lease, and tells the owner', () => {
    const { f } = asked()
    const before = sweepLiveness(f.state, NOW + BUDDY_MODEL_LEASE_MS - 1)
    expect(f.agent().modelRequest).toBeDefined()
    expect(before.map(m => m.text)).not.toContain("Couldn't switch your Buddy: its computer didn't answer. It is still on your subscription.")
    const after = sweepLiveness(f.state, NOW + BUDDY_MODEL_LEASE_MS)
    expect(f.agent().modelRequest).toBeUndefined()
    expect(after.filter(m => m.conversationId === f.chat).map(m => m.text))
      .toEqual(["Couldn't switch your Buddy: its computer didn't answer. It is still on your subscription."])
  })
})
