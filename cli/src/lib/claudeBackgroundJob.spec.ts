import { describe, expect, it } from 'vitest'
import { conflictingBackgroundJob, stopConflictingBackgroundJob, type ClaudeAgentListEntry } from './claudeBackgroundJob.js'

const BG_MATCH: ClaudeAgentListEntry = { id: '06b52258', sessionId: 's1', kind: 'background' }
const BG_OTHER: ClaudeAgentListEntry = { id: 'aaaa1111', sessionId: 's2', kind: 'background' }
const INTERACTIVE_MATCH: ClaudeAgentListEntry = { sessionId: 's1', kind: 'interactive', pid: 1 }

describe('conflictingBackgroundJob', () => {
  it('finds the live background job holding the exact session', () => {
    expect(conflictingBackgroundJob([BG_OTHER, BG_MATCH], 's1')).toEqual(BG_MATCH)
  })
  it('ignores a different session id', () => {
    expect(conflictingBackgroundJob([BG_OTHER], 's1')).toBeNull()
  })
  it('ignores a non-background kind even with the same session id', () => {
    expect(conflictingBackgroundJob([INTERACTIVE_MATCH], 's1')).toBeNull()
  })
  it('ignores an entry with no id', () => {
    expect(conflictingBackgroundJob([{ sessionId: 's1', kind: 'background' }], 's1')).toBeNull()
  })
  it('is null for an empty list', () => {
    expect(conflictingBackgroundJob([], 's1')).toBeNull()
  })
})

describe('stopConflictingBackgroundJob', () => {
  it('stops the live background job holding the exact session, then waits for it to leave the listing', async () => {
    const calls: Array<{ args: readonly string[]; timeoutMs: number }> = []
    let listCount = 0
    const exec = async (bin: string, args: readonly string[], timeoutMs: number) => {
      calls.push({ args, timeoutMs })
      if (args[0] === 'agents') {
        listCount++
        // First list: still held. Second list (after stop): gone.
        return JSON.stringify(listCount === 1 ? [BG_MATCH] : [])
      }
      if (args[0] === 'stop') return ''
      throw new Error(`unexpected exec ${args.join(' ')}`)
    }
    await stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec })
    expect(calls).toEqual([
      { args: ['agents', '--json'], timeoutMs: 3_000 },
      { args: ['stop', '06b52258'], timeoutMs: 3_000 },
      { args: ['agents', '--json'], timeoutMs: 3_000 },
    ])
  })

  it('never stops a background job that is not the exact session being resumed', async () => {
    const calls: string[][] = []
    const exec = async (_bin: string, args: readonly string[]) => {
      calls.push([...args])
      return args[0] === 'agents' ? JSON.stringify([BG_OTHER]) : ''
    }
    await stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec })
    expect(calls).toEqual([['agents', '--json']])
  })

  it('is a no-op when the listing fails (missing subcommand, non-zero exit, timeout)', async () => {
    const calls: string[][] = []
    const exec = async (_bin: string, args: readonly string[]) => { calls.push([...args]); return null }
    await expect(stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec })).resolves.toBeUndefined()
    expect(calls).toEqual([['agents', '--json']])
  })

  it('is a no-op when the listing is not the documented JSON array', async () => {
    const exec = async (_bin: string, args: readonly string[]) => args[0] === 'agents' ? 'not json' : ''
    await expect(stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec })).resolves.toBeUndefined()
  })

  it('resolves without throwing when the stop call itself fails', async () => {
    const log: string[] = []
    const exec = async (_bin: string, args: readonly string[]) =>
      args[0] === 'agents' ? JSON.stringify([BG_MATCH]) : null
    await expect(stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec, log: m => log.push(m) })).resolves.toBeUndefined()
    expect(log[0]).toContain('could not stop background job 06b52258')
  })

  it('gives up waiting for the job to leave the listing after its bounded budget, never hanging', async () => {
    let clock = 0
    const now = () => clock
    const sleep = async (ms: number) => { clock += ms }
    let listCalls = 0
    const exec = async (_bin: string, args: readonly string[]) => {
      if (args[0] === 'stop') return ''
      listCalls++
      return JSON.stringify([BG_MATCH]) // never leaves the listing
    }
    await stopConflictingBackgroundJob({ bin: 'claude', sessionId: 's1', exec, now, sleep, pollBudgetMs: 1_000, pollIntervalMs: 250 })
    // One list before the stop, then polls while now() < deadline (4 more at 250ms steps to reach 1000).
    expect(listCalls).toBe(5)
    expect(clock).toBeGreaterThanOrEqual(1_000)
  })

  it('passes the launch binary, session env and bin through to every call', async () => {
    const seen: Array<{ bin: string; env?: NodeJS.ProcessEnv }> = []
    const env = { CLAUDE_CONFIG_DIR: '/custom' }
    const exec = async (bin: string, args: readonly string[], _timeoutMs: number, callEnv?: NodeJS.ProcessEnv) => {
      seen.push({ bin, env: callEnv })
      return args[0] === 'agents' ? JSON.stringify([]) : ''
    }
    await stopConflictingBackgroundJob({ bin: '/opt/claude/claude', sessionId: 's1', env, exec })
    expect(seen).toEqual([{ bin: '/opt/claude/claude', env }])
  })
})
