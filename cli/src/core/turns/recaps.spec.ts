import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentNotifications } from '../../lib/agentNotifications.js'
import { SUBAGENT_IDLE_MS, type CommanderMirrorOpts } from '../../lib/commander.js'
import { deriveTurnSummary } from '../../lib/deviceRecap.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { ActivityFrame } from '../../lib/turnActivity.js'
import { createRecaps, type RecapDeps } from './recaps.js'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'core-recaps-')); dirs.push(dir); return dir }

function setup(over: Partial<RecapDeps> = {}) {
  const transcripts = temp()
  const transcriptPath = join(transcripts, 'main.jsonl')
  const live = { agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work/app', transcriptPath } as RegisteredSession
  const bare = { agentId: 'a2', sessionId: 's2', engine: 'claude', cwd: '/work/other' } as RegisteredSession
  const sessions = new Map([['s1', live], ['s2', bare]])
  const deps: RecapDeps = {
    notifications: new AgentNotifications(),
    turnActivity: { snapshot: vi.fn(() => undefined) },
    clients: { sendCommander: vi.fn(), send: vi.fn(), hasActiveCommander: vi.fn(() => false) },
    deviceIsWatching: vi.fn(() => true),
    cableWatchingLocal: vi.fn(() => false),
    bySession: (sessionId) => sessions.get(sessionId),
    resolve: (id) => id === 'a1' ? live : undefined,
    stopped: (agentId) => agentId === 'gone' ? ({ agentId: 'gone', sessionId: 'old-s' } as RegisteredSession) : null,
    orchestratorRoleOf: vi.fn(() => null),
    readLastTurn: vi.fn(async () => null),
    dataDir: temp(),
    recapForce: false,
    recapWithoutDevice: () => true,
    ...over,
  }
  const recaps = createRecaps(deps)
  const opts = (recaps.mirror as unknown as { opts: CommanderMirrorOpts }).opts
  return { deps, recaps, opts, live, transcriptPath }
}

describe('recaps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('counts a specialist\'s turn, or a director\'s while specialists are out, as a sub-agent\'s', () => {
    const { deps, recaps } = setup()
    const role = vi.mocked(deps.orchestratorRoleOf)
    expect(recaps.isSubagentSession('nobody')).toBe(false)
    expect(recaps.isSubagentSession('s1')).toBe(false)
    role.mockReturnValueOnce({ role: 'worker' })
    expect(recaps.isSubagentSession('s1')).toBe(true)
    role.mockReturnValueOnce({ role: 'director', busy: true })
    expect(recaps.isSubagentSession('s1')).toBe(true)
    role.mockReturnValueOnce({ role: 'director', busy: false })
    expect(recaps.isSubagentSession('s1')).toBe(false)
    expect(role).toHaveBeenCalledWith('a1')
  })

  it('takes an agent whose role cannot be read for anyone\'s: the turn keeps its end (e2e/diskfull.e2e.ts)', () => {
    const { deps, recaps } = setup()
    vi.mocked(deps.orchestratorRoleOf).mockImplementationOnce(() => { throw new Error('ENOSPC: no space left on device, mkdir') })
    expect(recaps.isSubagentSession('s1')).toBe(false)
  })

  it('gives the mirror the clients, the device gates and an excerpt for a recap', async () => {
    const { deps, opts } = setup()
    vi.mocked(deps.turnActivity.snapshot).mockReturnValueOnce({ state: 'working' } as ActivityFrame).mockReturnValueOnce({ state: 'idle' } as ActivityFrame)
    expect(opts.verifiedWorking!('s1')).toBe(true)
    expect(opts.verifiedWorking!('s1')).toBe(false)
    const frame = { type: 'commander_event', agentId: 'a1', dbSessionId: 's1', payload: {} } as Parameters<CommanderMirrorOpts['send']>[0]
    opts.send(frame)
    opts.sendWeb({ type: 'turn_summary' })
    expect(deps.clients.sendCommander).toHaveBeenCalledWith(frame)
    expect(deps.clients.send).toHaveBeenCalledWith({ type: 'turn_summary' })
    expect(opts.hasDevice!()).toBe(true)
    expect(opts.active!()).toBe(false)
    vi.mocked(deps.cableWatchingLocal).mockReturnValueOnce(true)
    expect(opts.active!()).toBe(true)
    vi.mocked(deps.clients.hasActiveCommander).mockReturnValueOnce(true)
    expect(opts.active!()).toBe(true)
    expect(await opts.summarize!('The fix is in. Tests pass.')).toEqual(await deriveTurnSummary('The fix is in. Tests pass.'))
    expect(opts.summarizeIsLocal).toBe(true)
    expect(opts.notifyWithoutDevice).toBe(true)
    expect(opts.notifications).toBe(deps.notifications)
    expect(opts.readLastTurn).toBe(deps.readLastTurn)
    expect(opts.dataDir).toBe(deps.dataDir)
    expect(opts.recapForce).toBe(false)
    expect((opts.alwaysGenerate as () => boolean)()).toBe(true)
  })

  it('names agents and asks about sub-agents the way the rest of the core does', () => {
    const { deps, opts, live } = setup()
    expect(opts.nameFor!('s1')).toBe(projectDisplayName(live))
    expect(opts.nameFor!('nobody')).toBeUndefined()
    expect(opts.agentIdFor!('s1')).toBe('a1')
    expect(opts.agentIdFor!('nobody')).toBeUndefined()
    vi.mocked(deps.orchestratorRoleOf).mockReturnValueOnce({ role: 'worker' })
    expect(opts.isSubagent!('s1')).toBe(true)
  })

  it('counts a Claude Code sub-agent as at work while its own transcript is still growing', () => {
    const { opts, transcriptPath } = setup()
    expect(opts.subagentActive!('s2', 'x'), 'no transcript').toBe(false)
    expect(opts.subagentActive!('s1', 'x'), 'no sub-agent file').toBe(false)
    const file = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', 'agent-x.jsonl')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}\n')
    expect(opts.subagentActive!('s1', 'x')).toBe(true)
    const old = (Date.now() - SUBAGENT_IDLE_MS - 60_000) / 1000
    utimesSync(file, old, old)
    expect(opts.subagentActive!('s1', 'x')).toBe(false)
  })

  it('looks recaps up under the engine session, asked for by agent, live or stopped', () => {
    const { recaps } = setup()
    const recent = vi.spyOn(recaps.mirror, 'recent').mockReturnValue([])
    const asks = vi.spyOn(recaps.mirror, 'recentAsks').mockReturnValue([])
    recaps.recent('a1', 3)
    recaps.recent('gone', 2)
    recaps.recent('s9', 1)
    recaps.recentAsks('a1', 5)
    recaps.recentAsks('gone')
    recaps.recentAsks('s9', 1)
    expect(recent.mock.calls).toEqual([['s1', 3], ['old-s', 2], ['s9', 1]])
    expect(asks.mock.calls).toEqual([['s1', 5], ['old-s', undefined], ['s9', 1]])
  })

  it('answers agent_recent with an agent\'s summaries and questions, two of each unless one to five are asked for', () => {
    const { recaps } = setup()
    const summary = { kind: 'summary', text: 'body', recap: 'recap' }
    const recent = vi.spyOn(recaps.mirror, 'recent').mockReturnValue([summary])
    const asks = vi.spyOn(recaps.mirror, 'recentAsks').mockReturnValue(['which build is this?'])
    expect(recaps.agentRecent({})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    const reply = recaps.agentRecent({ agentId: 'a1' })
    expect(reply).toStrictEqual({ agentId: 'a1', events: [summary], asks: ['which build is this?'] })
    expect(Object.keys(reply)).toEqual(['agentId', 'events', 'asks'])
    for (const n of [0, 'many', 9, -3, 3.5]) recaps.agentRecent({ agentId: 'a1', n })
    expect(recent.mock.calls.map(([, n]) => n)).toEqual([2, 2, 2, 5, 1, 3.5])
    expect(asks.mock.calls.map(([, n]) => n)).toEqual([2, 2, 2, 5, 1, 3.5])
    expect(recent).toHaveBeenCalledWith('s1', 2)
  })
})
