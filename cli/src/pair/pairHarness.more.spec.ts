/**
 * pair/pairHarness.ts, the failure paths: an install or a create that fails, a resume that cannot bring the
 * conversation back, a talk that throws (the queue must not wedge), a state file that is not ours, and an
 * idle check that races a harness which changed under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairHarness, pairInstructions, pairPackage, type PairHarnessDeps, type PairHarnessRow } from './pairHarness.js'
import { PairToken } from './token.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-harness-more-'))
  vi.useFakeTimers({ now: 5_000_000 })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function world(over: Partial<PairHarnessDeps> = {}) {
  const rows: PairHarnessRow[] = []
  let n = 0
  let working = false
  const token = new PairToken(join(dir, 'pair', 'token'))
  const deps: PairHarnessDeps = {
    pairedDaemon: () => 'tim',
    engine: async () => 'claude',
    mcpCommand: () => ['/bin/harness'],
    token,
    workspace: join(dir, 'pair', 'workspace'),
    stateFile: join(dir, 'pair', 'harness.json'),
    install: vi.fn(() => true),
    find: () => rows.map((r) => ({ ...r })),
    create: vi.fn<PairHarnessDeps['create']>(async () => { const agentId = `pair-${++n}`; rows.push({ agentId, status: 'live' }); return { ok: true, agentId } }),
    resume: vi.fn<PairHarnessDeps['resume']>(async (agentId) => { rows.find((r) => r.agentId === agentId)!.status = 'live'; return { ok: true } }),
    stop: vi.fn<PairHarnessDeps['stop']>(async (agentId) => { rows.find((r) => r.agentId === agentId)!.status = 'stopped' }),
    send: vi.fn(),
    working: () => working,
    now: Date.now,
    idleMs: 60_000,
    ...over,
  }
  const harness = new PairHarness(deps)
  return { harness, deps, rows, token, setWorking: (w: boolean) => { working = w } }
}

describe('the instructions and the package', () => {
  it('still names the daemon — and invents nothing — for one the roster does not know', () => {
    const text = pairInstructions('ghost')
    expect(text).toContain('You are **ghost**')
    expect(text).not.toMatch(/Family:|Your first words were/)
    expect(text).toMatch(/\{summary\}` a brief\):\n\n\nTalk the way/)   // no lines to quote
    expect(text).toContain('## The floor (never, at any level)')
  })

  it('keeps the package name within 40 characters', () => {
    const manifest = JSON.parse(pairPackage({ daemonId: 'x'.repeat(60), engine: 'codex', mcpCommand: ['h'], tokenFile: '/t' })['harness.json']!.content)
    expect(manifest.name).toHaveLength(40)
    expect(manifest.agent.env.DSH_PERMISSION_MODE).toBe('ask')
  })
})

describe('talk, when something fails', () => {
  it('stops at an install that fails: nothing created, no token issued', async () => {
    const w = world({ install: vi.fn(() => false) })
    expect(await w.harness.talk('hi')).toMatchObject({ ok: false, error: 'INSTALL_FAILED' })
    expect(w.deps.create).not.toHaveBeenCalled()
    expect(w.token.launched).toBe(false)
  })

  it('passes a failed create back, remembers nothing, and tries again on the next talk', async () => {
    const create = vi.fn<PairHarnessDeps['create']>()
      .mockResolvedValueOnce({ ok: false, error: 'ENGINE_MISSING', detail: 'claude is not on PATH' })
    const w = world({ create })
    expect(await w.harness.talk('hi')).toEqual({ ok: false, error: 'ENGINE_MISSING', detail: 'claude is not on PATH' })
    expect(w.harness.agentId()).toBeNull()
    expect(existsSync(join(dir, 'pair', 'harness.json'))).toBe(false)
    create.mockImplementationOnce(async () => { w.rows.push({ agentId: 'pair-9', status: 'live' }); return { ok: true, agentId: 'pair-9' } })
    expect(await w.harness.talk('hi again')).toEqual({ ok: true, agentId: 'pair-9', started: true })
    expect(w.harness.agentId()).toBe('pair-9')
  })

  it('does not wedge the queue when a talk throws', async () => {
    const create = vi.fn<PairHarnessDeps['create']>()
    const w = world({ create })
    create.mockRejectedValueOnce(new Error('backend gone'))
      .mockImplementationOnce(async () => { w.rows.push({ agentId: 'pair-2', status: 'live' }); return { ok: true, agentId: 'pair-2' } })
    const first = w.harness.talk('one')
    const second = w.harness.talk('two')
    await expect(first).rejects.toThrow('backend gone')
    expect(await second).toEqual({ ok: true, agentId: 'pair-2', started: true })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'two' }))
  })

  it('starts a new conversation when a paused one cannot come back, rather than leave the person unheard', async () => {
    const w = world()
    await w.harness.talk('hi')
    w.rows[0].status = 'stopped'
    ;(w.deps.resume as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'RESUME_FAILED' })
    expect(await w.harness.talk('are you there?')).toEqual({ ok: true, agentId: 'pair-2', started: true })
    expect(w.deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'are you there?' }))
    expect(w.harness.agentId()).toBe('pair-2')
  })

  it('a new revision over a PAUSED pair starts a new one without stopping anything', async () => {
    let engine: 'claude' | 'codex' = 'claude'
    const w = world({ engine: async () => engine })
    await w.harness.talk('hi')
    w.rows[0].status = 'stopped'
    engine = 'codex'
    expect(await w.harness.talk('hi on codex')).toEqual({ ok: true, agentId: 'pair-2', started: true })
    expect(w.deps.stop).not.toHaveBeenCalled()
    expect(w.deps.resume).not.toHaveBeenCalled()
  })

  it('a new revision over a live pair that refuses to stop still starts the new one', async () => {
    let engine: 'claude' | 'codex' = 'claude'
    const w = world({ engine: async () => engine, stop: vi.fn(async () => { throw new Error('busy') }) })
    await w.harness.talk('hi')
    engine = 'codex'
    expect(await w.harness.talk('hi on codex')).toMatchObject({ ok: true, started: true, agentId: 'pair-2' })
  })
})

describe('the saved state', () => {
  it('is not ours when it is not JSON, or its fields are the wrong type', () => {
    const w = world()
    mkdirSync(join(dir, 'pair'), { recursive: true })
    expect(w.harness.agentId()).toBeNull()
    writeFileSync(join(dir, 'pair', 'harness.json'), 'not json')
    expect(w.harness.agentId()).toBeNull()
    writeFileSync(join(dir, 'pair', 'harness.json'), JSON.stringify({ agentId: 7, revision: 'r' }))
    expect(w.harness.agentId()).toBeNull()
    writeFileSync(join(dir, 'pair', 'harness.json'), JSON.stringify({ agentId: 'a' }))
    expect(w.harness.agentId()).toBeNull()
    writeFileSync(join(dir, 'pair', 'harness.json'), JSON.stringify({ agentId: 'a', revision: 'r' }))
    expect(w.harness.agentId()).toBe('a')
  })
})

describe('idleCheck', () => {
  it('does nothing — and stops watching — when there is no pair, or it is not live', async () => {
    const w = world()
    expect(await w.harness.idleCheck()).toBe(false)
    await w.harness.talk('hi')
    w.rows[0].status = 'stopped'
    expect(await w.harness.idleCheck()).toBe(false)
    w.rows.length = 0
    expect(await w.harness.idleCheck()).toBe(false)
    expect(w.deps.stop).not.toHaveBeenCalled()
  })

  it('counts only the pair\'s own activity as use', async () => {
    const w = world()
    await w.harness.talk('hi')
    w.harness.stopWatching()   // checked by hand here, not by the interval
    vi.advanceTimersByTime(59_000)
    w.harness.activity('some-other-agent')
    vi.advanceTimersByTime(1_000)
    expect(await w.harness.idleCheck()).toBe(true)
    expect(w.deps.stop).toHaveBeenCalledWith('pair-1')
  })

  it('tries again later when the stop fails (it changed under us)', async () => {
    const stop = vi.fn<PairHarnessDeps['stop']>().mockRejectedValueOnce(new Error('changed'))
    const w = world({ stop })
    await w.harness.talk('hi')
    w.harness.stopWatching()
    vi.advanceTimersByTime(60_000)
    expect(await w.harness.idleCheck()).toBe(false)
    stop.mockImplementationOnce(async () => { w.rows[0].status = 'stopped' })
    expect(await w.harness.idleCheck()).toBe(true)
  })

  it('stopWatching: no idle timer fires after it', async () => {
    const w = world()
    await w.harness.talk('hi')
    w.harness.stopWatching()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(w.deps.stop).not.toHaveBeenCalled()
    // …and a talk that resumes starts watching again.
    w.rows[0].status = 'stopped'
    await w.harness.talk('back')
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(w.deps.stop).toHaveBeenCalledWith('pair-1')
  })
})
