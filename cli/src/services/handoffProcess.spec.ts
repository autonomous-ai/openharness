import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { HANDOFF_REQUESTS, type CoreApi } from '../core/api.js'
import { databaseHistory } from '../lib/databaseHistory.js'
import { startHandoff } from './handoff.js'
import { handoffCoreApi, runHandoffService } from './handoffProcess.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'

vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
// The SQLite binding, faked: an OpenCode store with one turn in it, and a count of the times it was loaded.
const binding = vi.hoisted(() => ({ loads: 0, reads: [] as Array<{ path: string; sql: string; params: unknown[] }> }))
vi.mock('../lib/sqliteBuiltin.js', () => {
  binding.loads++
  const part = (type: string, text: string) => JSON.stringify({ type, text })
  return {
    builtinSqlite: () => class {},
    readBuiltin: (_database: unknown, path: string, sql: string, params: unknown[]) => {
      binding.reads.push({ path, sql, params })
      return { ok: true, via: 'builtin', rows: [
        { mid: 'msg_1', mtc: 1, mdata: JSON.stringify({ role: 'user' }), pid: 'prt_1', pdata: part('text', 'add a login page') },
        { mid: 'msg_2', mtc: 2, mdata: JSON.stringify({ role: 'assistant' }), pid: 'prt_2', pdata: part('text', 'Added the login page.') },
      ] }
    },
  }
})
afterEach(() => vi.clearAllMocks())

describe('the handoff in the edge host', () => {
  it('queries current retained records, recaps, and verified paths with their exact arguments', async () => {
    let value: unknown = { agentId: 'stopped', engine: 'claude' }
    const ask = vi.fn(async () => ({ value }))
    const core = handoffCoreApi('/data', ask)
    expect(core.dataDir).toBe('/data')
    expect(core.transcripts.databaseHistory).toBe(databaseHistory)
    expect(core.transcripts.databaseHistory({ engine: 'claude' } as never)).toBeUndefined()
    expect(await core.conversations.resolve('stopped')).toBe(value)
    expect(ask).toHaveBeenLastCalledWith('resolve', { id: 'stopped' })
    value = { agentId: 'new' }
    expect(await core.conversations.resolve('stopped')).toBe(value)
    value = ['ask', 7, null]
    expect(await core.conversations.recentAsks('s', 20)).toEqual(['ask'])
    expect(ask).toHaveBeenLastCalledWith('recentAsks', { id: 's', n: 20 })
    value = ['recap']
    expect(await core.conversations.recaps('s', 5)).toEqual(['recap'])
    expect(ask).toHaveBeenLastCalledWith('recaps', { id: 's', n: 5 })
    value = 'whole answer'
    expect(await core.conversations.lastFullText('s')).toBe(value)
    expect(ask).toHaveBeenLastCalledWith('lastFullText', { id: 's' })
    value = { engine: 'claude', sessionId: 's', transcriptPath: '/s.jsonl', ignored: true }
    expect(await core.conversations.discover('a')).toEqual({ engine: 'claude', sessionId: 's', transcriptPath: '/s.jsonl' })
    expect(ask).toHaveBeenLastCalledWith('discover', { id: 'a' })
    value = '/codex/s.jsonl'
    expect(await core.conversations.findTranscript('codex', 's', { codexHome: '/home' })).toBe(value)
    expect(ask).toHaveBeenLastCalledWith('findTranscript', { engine: 'codex', id: 's', codexHome: '/home' })
    value = true
    expect(await core.conversations.transcriptOk('codex', '/path', null)).toBe(true)
    expect(ask).toHaveBeenLastCalledWith('transcriptOk', { engine: 'codex', path: '/path', codexHome: null })
  })

  it('never uses a remembered record or guesses when a query has no valid answer', async () => {
    const core = handoffCoreApi('/data', async () => ({}))
    expect(await core.conversations.resolve('gone')).toBeNull()
    expect(await core.conversations.recentAsks('s', 20)).toEqual([])
    expect(await core.conversations.recaps('s', 5)).toEqual([])
    expect(await core.conversations.lastFullText('s')).toBeNull()
    expect(await core.conversations.discover('a')).toBeNull()
    expect(await core.conversations.findTranscript('codex', 's', {})).toBeNull()
    expect(await core.conversations.transcriptOk('codex', '/path', null)).toBe(false)
    for (const value of [null, {}, { engine: 7 }, { engine: 'unknown' }, { engine: 'claude' }, { engine: 'claude', sessionId: 's' }]) {
      expect(await handoffCoreApi('/data', async () => ({ value })).conversations.discover('a')).toBeNull()
    }
    await expect(handoffCoreApi('/data', async () => ({ error: 'QUERY_FAILED' })).conversations.resolve('a')).rejects.toThrow('the core did not answer')
    await expect(handoffCoreApi('/data', async () => { throw new Error('disconnected') }).conversations.resolve('a')).rejects.toThrow('disconnected')
  })

  it('uses each current connection and the normal service runner, without a real socket in tests', async () => {
    let options!: ServiceProcessOptions, api!: CoreApi
    const stop = vi.fn()
    const running = runHandoffService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: given => { options = given; return { stop } },
      start: core => { api = core; return { agent_handoff_prepare: async () => ({ value: await core.conversations.resolve('a') }) } },
    })
    expect(options).toMatchObject({ name: 'handoff', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await api.conversations.resolve('a')).toBeNull()
    const query = vi.fn(async () => ({ value: { agentId: 'a' } }))
    options.onConnected!({ query })
    expect(await options.requests.agent_handoff_prepare!({}, { local: true, owner: true })).toEqual({ value: { agentId: 'a' } })
    expect(query).toHaveBeenLastCalledWith('resolve', { id: 'a' })
    options.onConnected!({ query: async () => ({ value: null }) })
    expect(await api.conversations.resolve('a')).toBeNull()
    running.stop()
    expect(stop).toHaveBeenCalledOnce()
    runHandoffService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests)).toEqual([...HANDOFF_REQUESTS])
  })

  it('loads the SQLite binding only for an engine that keeps its conversation in a store, and hands that one over', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'handoff-store-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: ws })
      const agents: Record<string, Record<string, unknown>> = {
        claude: { agentId: 'claude-1', sessionId: 's1', engine: 'claude', cwd: ws, transcriptPath: null, registeredAt: Date.now() - 60_000 },
        opencode: { agentId: 'opencode-1', sessionId: 'ses_handoff1', engine: 'opencode', cwd: ws, transcriptPath: null, registeredAt: Date.now() - 60_000 },
      }
      const core = handoffCoreApi('/data', async (query, payload) => ({
        value: query === 'resolve' ? Object.values(agents).find((agent) => agent.agentId === payload.id) ?? null
          : query === 'recentAsks' || query === 'recaps' ? [] : null,
      }))
      // Claude Code and Codex keep a transcript file: nothing to read from a store, and the binding stays out.
      expect(core.transcripts.databaseHistory(agents.claude as never)).toBeUndefined()
      expect(core.transcripts.databaseHistory({ ...agents.claude, engine: 'codex' } as never)).toBeUndefined()
      const prepare = startHandoff(core).agent_handoff_prepare!
      const asker = { local: true, owner: true }
      await prepare({ agentId: 'claude-1', changeId: 'c'.repeat(32), targetEngine: 'codex' }, asker)
      expect(binding.loads).toBe(0)
      // OpenCode: read through the binding, loaded for that read, and the turn it holds handed over.
      const handed = await prepare({ agentId: 'opencode-1', changeId: 'a'.repeat(32), targetEngine: 'claude' }, asker) as { file: string | null }
      expect(binding.loads).toBe(1)
      expect(binding.reads).toEqual([{ path: join(env.OPENCODE_DATA_DIR, 'opencode.db'), sql: expect.stringContaining('FROM message m'), params: ['ses_handoff1'] }])
      expect(handed.file).toEqual(expect.any(String))
      expect(readFileSync(join(ws, handed.file!), 'utf8')).toContain('add a login page')
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})
