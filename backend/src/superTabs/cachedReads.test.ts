import { describe, expect, it } from 'vitest'
import { stableId, type AgentStart } from './model.js'
import type { Part } from './parts/index.js'
import { namedStarts } from './cachedReads.js'

/** A start, finished once it has a harness. `untouchable`: reading its request throws, so a test sees the read hash its
 *  agent (stableId, a sha256 of the request's machine and the harness). */
const start = (key: string, done: boolean, untouchable = false): Part<AgentStart> => {
  const data = { id: key, harnessId: done ? `${key}-harness` : null } as Record<string, unknown>
  Object.defineProperty(data, 'request', { enumerable: true, get: () => {
    if (untouchable) throw new Error(`read the request of ${key}`)
    return { machineId: 'host', conversationId: 'c' }
  } })
  return { kind: 'start', key, version: 1, changedAt: 1, ordinal: 1, data: data as unknown as AgentStart }
}

describe('the starts a read keeps (cachedReads.ts namedStarts)', () => {
  it('keeps the unfinished starts without hashing any finished one when no agent is named (prod 10-30: 873 a messages read)', () => {
    const all = [...Array.from({ length: 1000 }, (_, i) => start(`old-${i}`, true, true)), start('queued', false)]
    expect(namedStarts(all, {}).map(s => s.key)).toEqual(['queued'])
    expect(namedStarts(all, { startIds: ['old-3'] }).map(s => s.key)).toEqual(['old-3', 'queued'])
  })

  it('keeps the finished starts named by id or by the agent they started, and every one for a first load', () => {
    const all = [...Array.from({ length: 10 }, (_, i) => start(`old-${i}`, true)), start('queued', false)]
    const agent = stableId('host', 'old-7-harness')
    expect(namedStarts(all, { startIds: ['old-3'], startAgentIds: [agent] }).map(s => s.key)).toEqual(['old-3', 'old-7', 'queued'])
    expect(namedStarts(all, { includeRecentStarts: true })).toBe(all)
  })
})
