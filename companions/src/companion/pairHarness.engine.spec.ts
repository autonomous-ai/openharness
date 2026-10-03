import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairHarness, type PairHarnessDeps, type PairHarnessRow } from './pairHarness.js'
import { PairToken } from './token.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-engine-')); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

function world() {
  let uid = 'tim-one'
  const rows: PairHarnessRow[] = []
  const deps: PairHarnessDeps = {
    pairedDaemon: () => 'tim', pairedUid: () => uid,
    collectionUids: () => uid === 'other-account' ? [uid] : ['tim-one', 'gnu-one'],
    engine: vi.fn(async preferred => preferred ?? null),
    mcpCommand: () => ['/bin/harness'], token: new PairToken(join(dir, 'token')),
    workspace: join(dir, 'workspace'), stateFile: join(dir, 'harness.json'),
    install: vi.fn(() => true), find: () => rows,
    create: vi.fn<PairHarnessDeps['create']>(async ({ engine, cwd }) => {
      const agentId = `agent-${rows.length + 1}`
      rows.push({ agentId, engine, cwd, status: 'live', hasConversation: true })
      return { ok: true, agentId }
    }),
    resume: vi.fn<PairHarnessDeps['resume']>(async id => { rows.find(r => r.agentId === id)!.status = 'live'; return { ok: true } }),
    stop: vi.fn(async id => { rows.find(r => r.agentId === id)!.status = 'stopped' }),
    send: vi.fn(), working: () => false, now: Date.now,
  }
  return { deps, rows, harness: new PairHarness(deps), select: (id: string) => { uid = id } }
}

it('remembers the explicit choice and starts a fresh conversation when switching agents', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  expect(w.harness.learningScope()).toBe('agent-1')
  await w.harness.open('tim-one', 'codex')
  expect(w.harness.engine()).toBe('codex')
  expect(w.harness.learningScope()).toBe('agent-1')
  expect(w.rows).toMatchObject([{ status: 'stopped', engine: 'claude' }, { status: 'live', engine: 'codex' }])
  expect(w.deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'codex', prompt: '' }))
  const restarted = new PairHarness(w.deps)
  w.select('gnu-one')
  await restarted.open('gnu-one')
  expect(restarted.engine()).toBe('codex')
  expect(w.deps.create).toHaveBeenCalledTimes(2)
  expect(await restarted.open('gnu-one', 'claude')).toMatchObject({ started: true, agentId: 'agent-3' })
  expect(restarted.learningScope()).toBe('agent-1')
  expect(w.deps.send).not.toHaveBeenCalled()
  const saved = JSON.parse(readFileSync(w.deps.stateFile, 'utf8'))
  expect(saved.collections).toHaveLength(3)
  expect(saved.engine).toBe('claude')
})

it('rejects an unavailable choice, then saves and switches even during a turn', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  vi.mocked(w.deps.engine).mockResolvedValue(null)
  expect(await w.harness.open('tim-one', 'codex')).toMatchObject({ error: 'NO_ENGINE' })
  expect(w.deps.stop).not.toHaveBeenCalled()
  w.deps.working = () => true
  vi.mocked(w.deps.engine).mockResolvedValue('codex')
  expect(await w.harness.open('tim-one', 'codex')).toMatchObject({ ok: true, started: true })
  expect(w.harness.engine()).toBe('codex')
  expect(w.deps.stop).toHaveBeenCalledWith('agent-1')
})

it('does not substitute a different engine if discovery returns the wrong one', async () => {
  const w = world()
  vi.mocked(w.deps.engine).mockResolvedValue('claude')
  expect(await w.harness.open('tim-one', 'codex')).toMatchObject({ error: 'NO_ENGINE' })
  expect(w.deps.create).not.toHaveBeenCalled()
})

it('keeps the old choice and history when launching the new engine fails', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  vi.mocked(w.deps.create).mockResolvedValueOnce({ ok: false, error: 'LAUNCH_FAILED' })
  expect(await w.harness.open('tim-one', 'codex')).toMatchObject({ error: 'LAUNCH_FAILED' })
  expect(w.harness.engine()).toBe('claude')
  expect(w.harness.learningScope()).toBe('agent-1')
  expect(await w.harness.open('tim-one')).toMatchObject({ resumed: true, agentId: 'agent-1' })
})

it('isolates engine preferences, transcripts and review scopes between collections', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  await w.harness.open('tim-one', 'codex')
  w.select('other-account')
  expect(w.harness.engine()).toBeNull()
  expect(w.harness.learningScope()).toBeNull()
  expect(await w.harness.open('tim-one', 'codex')).toMatchObject({ error: 'STALE_COMPANION' })
  await w.harness.open('other-account', 'codex')
  expect(w.harness.learningScope()).toBe('agent-3')
  w.select('tim-one')
  expect(w.harness.engine()).toBe('codex')
  expect(w.harness.learningScope()).toBe('agent-1')
  await w.harness.open('tim-one', 'claude')
  expect(w.harness.agentId()).toBe('agent-4')
})

it('keeps the same folder when a different member of the collection changes agent', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  const folder = w.rows[0].cwd
  w.select('gnu-one')
  await w.harness.open('gnu-one', 'codex')
  expect(w.rows[1].cwd).toBe(folder)
})

it('does not bind a late engine launch to another account', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  let finish!: (value: { ok: true; agentId: string }) => void
  vi.mocked(w.deps.create).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve }))
  const opening = w.harness.open('tim-one', 'codex')
  await vi.waitFor(() => expect(finish).toBeDefined())
  w.select('other-account')
  w.rows.push({ agentId: 'late-codex', engine: 'codex', status: 'live' })
  finish({ ok: true, agentId: 'late-codex' })
  expect(await opening).toMatchObject({ error: 'STALE_COMPANION' })
  expect(w.deps.stop).toHaveBeenCalledWith('late-codex')
  expect(w.harness.agentId()).toBeNull()
})

it('uses OpenCode for a new collection without submitting a prompt', async () => {
  const w = world()
  expect(await w.harness.open('tim-one')).toMatchObject({ ok: true, started: true })
  expect(w.deps.create).toHaveBeenCalledWith(expect.objectContaining({ engine: 'opencode', prompt: '' }))
  expect(w.deps.send).not.toHaveBeenCalled()
})

it('does not create a replacement if saving and stopping fails', async () => {
  const w = world()
  await w.harness.open('tim-one', 'claude')
  vi.mocked(w.deps.stop).mockRejectedValue(new Error('Could not save'))
  await expect(w.harness.open('tim-one', 'codex')).rejects.toThrow('Could not save')
  expect(w.deps.create).toHaveBeenCalledTimes(1)
  expect(w.harness.engine()).toBe('claude')
})
