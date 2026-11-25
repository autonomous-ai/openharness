import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createTerminalSessions } from './sessions.js'

const held = { state: 'held', service: 'native', detail: 'Starting again.', nativeToken: 'token', startsAgain: true } as const

function sessionsOf(row: RegisteredSession) {
  return createTerminalSessions({
    agents: { byAgent: (agentId) => agentId === row.agentId ? row : undefined, displayName: () => 'project', terminalAvailable: () => true },
    paneState: vi.fn(), processState: vi.fn(),
  })
}

describe('the shell service\'s view of an agent', () => {
  it.each(['', 's-a'])('describes a guard-held launch to the shell service as starting (session %j)', async (sessionId) => {
    const row = { agentId: 'a', sessionId, engine: 'claude', cwd: '/work/project', projectDir: 'project', active: false, launch: held } as RegisteredSession
    // The guard's hold starts again by itself; the registry keeps the true hold for the restore.
    expect((await sessionsOf(row).describe('a'))?.launch).toEqual({ state: 'starting' })
    expect(row.launch).toBe(held)
  })

  it('describes a row with no launch record as having none', async () => {
    const row = { agentId: 'a', sessionId: 's-a', engine: 'claude', cwd: '/work/project', projectDir: 'project', active: true } as RegisteredSession
    expect(await sessionsOf(row).describe('a')).toMatchObject({ id: 'a', launch: undefined })
  })
})
