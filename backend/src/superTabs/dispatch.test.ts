import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation, type MessageDraft } from './model.js'
import { DISPATCH_RULES, laneOf } from './dispatch.js'
import { loseTasks } from './liveness.js'
import { groupView } from './read/views.js'
import { storedAssignment } from './storedWork.test-support.js'

// A stored task's lane and its progress clock (dispatch.ts): the hand-out itself went with Swarm v4 (2026-11-10).
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const contribution = { machineOwnerId: 'host-owner', contributorId: 'owner' }

/** A Swarm with a PM and the agents [names], all on 'host'; `task` opens a task owning [owns]. */
function crewSwarm(names: string[] = []) {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, commandSchema.parse(command), { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, lead = false) => run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution }).result.agentId as string
  add('PM', true)
  const ids = Object.fromEntries(names.map(name => [name, add(name)]))
  const task = (title: string, owns: string[]) => run({ type: 'conversation.create', title,
    task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns }, checks: [] } as Command).result.conversationId as string
  const group = (id: string): Conversation => state.conversations.find(c => c.id === id)!
  return { ids, task, group, get state() { return state } }
}

describe('a task\'s lane', () => {
  const lanes = DISPATCH_RULES.lanes

  it('is the lane that owns most of its paths, a tie going to the table\'s first', () => {
    const s = crewSwarm()
    expect(laneOf(s.group(s.task('Server', ['backend/src/superTabs/x.ts'])), lanes)).toBe('backend')
    expect(laneOf(s.group(s.task('Board', ['desktop/lib/a.dart', 'backend/src/b.ts', 'desktop/test/c_test.dart'])), lanes)).toBe('Desktop')
    expect(laneOf(s.group(s.task('Both', ['cli/src/a.ts', 'mobile/lib/b.dart'])), lanes)).toBe('CLI')
    expect(laneOf(s.group(s.task('Docs', ['docs/plans/'])), lanes)).toBe('docs')
    expect(laneOf(s.group(s.task('Elsewhere', ['firmware/main.c'])), lanes)).toBeNull()
    // A path that only starts like a lane's is not in it.
    expect(laneOf(s.group(s.task('Lookalike', ['backend-tools/run.sh'])), lanes)).toBeNull()
  })
})

describe('the crew\'s clock: 3 hours without progress puts the task back in its lane', () => {
  const HOUR = 3_600_000, AT = 1000
  /** Ash (crew, backend) working on Api since AT; Birch (crew, backend) free. */
  function working(crew = true) {
    const s = crewSwarm(['Ash', 'Birch'])
    if (crew) for (const name of ['Ash', 'Birch']) s.state.agents.find(a => a.id === s.ids[name])!.crew = { role: 'Engineer', lane: 'backend', at: AT, by: 'owner' }
    const api = s.task('Api', ['backend/src/a.ts'])
    storedAssignment(s.state, api, s.ids.Ash!, AT)
    /** The loss check at [now], with the machine reporting every session running and busy on screen till then. */
    const sweep = (now: number) => {
      s.state.machines = [{ machineId: 'host', name: 'Mac', observation: { runningHarnessIds: s.state.agents.map(a => a.harnessId),
        stoppedHarnessIds: [], receivedAt: now, harnessProgress: Object.fromEntries(s.state.agents.map(a => [a.harnessId, now])) } }] as never
      return loseTasks(s.state, now)
    }
    const lines = (rows: MessageDraft[]) => rows.filter(r => r.conversationId === api && r.recipients.includes(s.ids.Ash!)).map(r => r.text)
    return { ...s, api, sweep, lines, get state() { return s.state } }
  }

  it.each([true, false])('returns the task at 3 hours for another worker (crew: %s)', crew => {
    const s = working(crew)
    s.sweep(AT + 3 * HOUR)
    const group = s.group(s.api)
    expect(group.assignment!.status).toBe('lost')
    expect(group.assignment!.lost!.reason).toBe('no progress for 3 hours: back in the backend lane')
  })

  it.each([true, false])('never ticks while blocked or waiting on a person or review (crew: %s)', crew => {
    const s = working(crew)
    s.group(s.api).assignment!.status = 'blocked'
    expect(s.lines(s.sweep(AT + 3 * HOUR))).toEqual([])
    expect(s.group(s.api).assignment!.status).toBe('blocked')
    s.group(s.api).assignment!.status = 'needs_human'
    s.sweep(AT + 4 * HOUR)
    expect(s.group(s.api).assignment!.status).toBe('needs_human')
    s.group(s.api).assignment!.status = 'review'
    s.sweep(AT + 5 * HOUR)
    expect(s.group(s.api).assignment!.status).toBe('review')
  })
})

describe('a task\'s hand-out lane', () => {
  it('reaches readers on each task, as its hand-out lane, so a change read that sends only changed tasks keeps every lane whole', () => {
    const s = crewSwarm(['Ash'])
    const server = s.task('Server', ['backend/src/x.ts']), elsewhere = s.task('Elsewhere', ['firmware/main.c'])
    expect(groupView(s.group(server), new Set())).toMatchObject({ handOutLane: 'backend' })
    expect(groupView(s.group(elsewhere), new Set())).toMatchObject({ handOutLane: null })
    // A chat has none.
    expect(groupView(s.group('lead'), new Set())).not.toHaveProperty('handOutLane')
  })
})
