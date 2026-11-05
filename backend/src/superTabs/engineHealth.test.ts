import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from './machines.js'
import type { AgentStart, SuperTabState } from './model.js'
import { ABANDONED, MACHINE_REMOVED } from './startFailure.js'
import { engineUnusable, noteStartFailed, noteStartSucceeded, readingClearsSuspensions, resumeEngine, SUSPENSION_MS, suspendedEngines } from './engineHealth.js'

const NOW = 10_000_000
const fine = { quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 40, resetsAt: null }] }],
  readiness: { engines: [{ engine: 'codex', installed: true, signedIn: true }] } }
const exhausted = { quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: null }] }],
  readiness: { engines: [{ engine: 'codex', installed: true, signedIn: true }] } }
function machine(reading: Record<string, unknown> = {}): ContributedMachine {
  return { machineId: 'm1', name: "Diego's Mac", contributorId: 'owner', membershipGeneration: 'g', generation: 'p', cwd: '/x', engines: ['claude', 'codex'],
    maxAgents: 2, paused: false, observation: { generation: 'p', receivedAt: NOW, resources: {} as never, tools: {}, quotas: [], runningHarnessIds: [],
      stoppedHarnessIds: [], ...reading } as never }
}
const stateWith = (pool: ContributedMachine) => ({ machines: [pool] }) as unknown as SuperTabState
let n = 0
const start = (extra: Partial<AgentStart['request']> = {}, error = 'Codex could not launch.'): AgentStart => ({ id: `s${++n}`, error,
  request: { conversationId: 'g1', machineId: 'm1', engine: 'codex', name: 'Builder', cwd: '/x', ...extra } }) as unknown as AgentStart

describe('an engine whose starts fail on a machine', () => {
  it.each([
    'The Harness server answered without a GitHub token for this project.',
    'This start has no authorized project.',
    'This project repository is unavailable.',
    'The project folder does not exist.',
    'Cannot create a worktree: the repository has no commits.',
    'Required tool gh is not installed.',
    'spawn gh ENOENT',
    "This machine's ChatGPT account (plus) does not offer gpt-6-astra; choose another model.",
    "This machine held the agent's launch for 3 minutes and stopped it: Waiting to confirm the selected executable’s permission flags.",
    'This agent does not support that permission mode.',
    'Its machine is signed in to another account now.',
    'Request refused by this account.',
    'Authentication failed while fetching the project.',
    'Unknown native preparation failure.',
  ])('does not penalize an engine for setup or an unclassified failure: %s', error => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start({}, error), NOW)
    expect(noteStartFailed(state, start({}, error), NOW)).toBeNull()
    expect(engineUnusable(pool, 'codex', NOW)).toBeNull()
    // Ignoring setup failures must not erase a real engine failure already counted.
    noteStartFailed(state, start(), NOW)
    noteStartFailed(state, start({}, error), NOW)
    expect(noteStartFailed(state, start(), NOW)).not.toBeNull()
  })

  it.each([
    'Codex could not launch.',
    'codex exited before its engine process became ready. See the terminal output for details.',
    'Its engine stopped on a question that nobody here can answer.',
    'Its engine stopped on a sign-in screen that nobody here can answer.',
    'Codex sign-in failed.',
    'Codex is installed but cannot run: it exited with status 1',
    'The agent was created and has since stopped. Create a new start request to continue.',
  ])('counts the engine’s own failure: %s', error => {
    const pool = machine(), state = stateWith(pool)
    expect(noteStartFailed(state, start({}, error), NOW)).toBeNull()
    expect(noteStartFailed(state, start({}, error), NOW)).toContain('Codex is suspended')
    expect(engineUnusable(pool, 'claude', NOW)).toBeNull()
  })

  it('is suspended there by its second failed start in a row, with one sentence for the notice', () => {
    const pool = machine(), state = stateWith(pool)
    expect(noteStartFailed(state, start(), NOW)).toBeNull()
    expect(suspendedEngines(pool, NOW)).toEqual({})
    const notice = noteStartFailed(state, start(), NOW)
    expect(notice).toContain('Codex is suspended on this machine for new work: its last 2 starts there failed.')
    expect(suspendedEngines(pool, NOW)).toEqual({ codex: expect.stringContaining('Codex is suspended on this machine') })
    expect(engineUnusable(pool, 'codex', NOW)).toContain('Codex is suspended on this machine')
    expect(engineUnusable(pool, 'claude', NOW)).toBeNull()
  })

  // 11-05: six first starts failed to clone on four machines, and each pair suspended the engine there for hours.
  it('is never suspended by starts that failed to clone the project, which is the network or GitHub, not the engine', () => {
    const pool = machine(), state = stateWith(pool)
    for (const error of ["This machine could not clone the project repository with the Harness GitHub App's token: Could not clone the repository (git said: early EOF). Check the URL and connection, then retry.",
      "This machine could not clone the project repository with the Harness GitHub App's token: Cloning stopped making progress after 120 s.",
      'This machine could not access the project repository over HTTPS or SSH. Its owner needs GitHub access to it here: run gh auth login.']) {
      for (let i = 0; i < 3; i++) expect(noteStartFailed(state, start({}, error), NOW)).toBeNull()
    }
    expect(pool.engineFailures).toBeUndefined()
    expect(suspendedEngines(pool, NOW)).toEqual({})
    // A real failure in between still counts, and clone failures do not reset the count.
    noteStartFailed(state, start(), NOW)
    expect(noteStartFailed(state, start({}, 'Could not clone the repository.'), NOW)).toBeNull()
    expect(noteStartFailed(state, start(), NOW)).not.toBeNull()
  })

  it('says so once per suspension, never on a later failed start or report', () => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start(), NOW)
    expect(noteStartFailed(state, start(), NOW)).not.toBeNull()
    expect(noteStartFailed(state, start(), NOW + 1)).toBeNull()
    expect(noteStartFailed(state, start(), NOW + 2)).toBeNull()
    readingClearsSuspensions(pool, NOW + 3)
    expect(noteStartFailed(state, start(), NOW + 4)).toBeNull()
  })

  it('counts only failures in a row: a start that ran in between resets the count', () => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start(), NOW)
    noteStartSucceeded(state, start({}, ''))
    expect(noteStartFailed(state, start(), NOW)).toBeNull()
    expect(suspendedEngines(pool, NOW)).toEqual({})
  })

  it('counts each engine apart, and never a grid model, a removal, an abandoned start, a memory refusal, a Product Manager or a Buddy', () => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start({ engine: 'claude' }), NOW)
    expect(noteStartFailed(state, start(), NOW)).toBeNull()
    for (const failed of [start({ gridModel: 'qwen3' }), start({}, MACHINE_REMOVED), start({}, ABANDONED), start({}, 'Removed by its owner before it started.'),
      start({}, 'Not enough free memory: 1.2 GiB free, 2 GiB needed.'),
      start({ leadFor: 'p1' } as never), start({ buddyOf: 'owner' } as never)]) {
      expect(noteStartFailed(state, failed, NOW)).toBeNull()
    }
    expect(suspendedEngines(pool, NOW)).toEqual({})
  })

  it('ends after 6 hours', () => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start(), NOW); noteStartFailed(state, start(), NOW)
    expect(suspendedEngines(pool, NOW + SUSPENSION_MS - 1)).not.toEqual({})
    expect(suspendedEngines(pool, NOW + SUSPENSION_MS)).toEqual({})
    expect(engineUnusable(pool, 'codex', NOW + SUSPENSION_MS)).toBeNull()
  })

  it('ends on the next reading that shows it signed in with quota left, when it did not read so as it was suspended', () => {
    const pool = machine(exhausted), state = stateWith(pool)
    noteStartFailed(state, start(), NOW); noteStartFailed(state, start(), NOW)
    readingClearsSuspensions(pool, NOW + 1)
    expect(suspendedEngines(pool, NOW + 1)).toHaveProperty('codex')
    Object.assign(pool.observation!, fine)
    readingClearsSuspensions(pool, NOW + 2)
    expect(suspendedEngines(pool, NOW + 2)).toEqual({})
  })

  it('stands through readings that already read fine as it was suspended, since its starts failed anyway', () => {
    const pool = machine(fine), state = stateWith(pool)
    noteStartFailed(state, start(), NOW); noteStartFailed(state, start(), NOW)
    const reason = suspendedEngines(pool, NOW).codex
    expect(reason).toContain('within 6 hours')
    expect(reason).not.toContain('reading')
    readingClearsSuspensions(pool, NOW + 1)
    expect(suspendedEngines(pool, NOW + 1)).toHaveProperty('codex')
  })

  it('ends when its owner resumes it', () => {
    const pool = machine(), state = stateWith(pool)
    noteStartFailed(state, start(), NOW); noteStartFailed(state, start(), NOW)
    expect(resumeEngine(pool, 'codex')).toBe(true)
    expect(suspendedEngines(pool, NOW)).toEqual({})
    expect(noteStartFailed(state, start(), NOW)).toBeNull()
    expect(resumeEngine(pool, 'codex')).toBe(false)
  })
})

describe('an engine a machine cannot run', () => {
  // Quota is information, not a gate (project instructions, phase 4): only signed out and suspended refuse a start.
  it('starts on an engine whose quota is used up', () => {
    expect(engineUnusable(machine(exhausted), 'codex', NOW)).toBeNull()
    expect(engineUnusable(machine({ ...exhausted, readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] } }), 'codex', NOW))
      .toBe('Codex is not signed in to a subscription on this machine.')
    const suspended = machine(exhausted), state = stateWith(suspended)
    noteStartFailed(state, start(), NOW)
    noteStartFailed(state, start(), NOW)
    expect(engineUnusable(suspended, 'codex', NOW)).toContain('Codex is suspended on this machine')
  })

  it('is one its reading says is signed out; unknown and older readings keep today\'s behaviour', () => {
    expect(engineUnusable(machine({ readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] } }), 'codex', NOW))
      .toBe('Codex is not signed in to a subscription on this machine.')
    expect(engineUnusable(machine(fine), 'codex', NOW)).toBeNull()
    expect(engineUnusable(machine({ readiness: { engines: [{ engine: 'codex', installed: true, signedIn: null }] },
      quotas: [{ engine: 'codex', known: false, windows: [] }] }), 'codex', NOW)).toBeNull()
    expect(engineUnusable(machine(), 'codex', NOW)).toBeNull()
    const none = machine(); delete none.observation
    expect(engineUnusable(none, 'codex', NOW)).toBeNull()
  })
})
