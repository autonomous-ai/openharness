/**
 * pair/pairHarness.ts, the failure paths: an install or a create that fails, a resume that cannot bring the
 * conversation back, a talk that throws (the queue must not wedge), a state file that is not ours, and an
 * idle check that races a harness which changed under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    engine: async preferred => preferred ?? 'opencode',
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
  it('never types into first-run setup and starts fresh if no conversation was created', async () => {
    const w = world()
    await w.harness.talk('first words')
    w.rows[0]!.hasConversation = false
    expect(await w.harness.talk('are you there?')).toMatchObject({ error: 'SETUP_REQUIRED', agentId: 'pair-1' })
    expect(w.deps.send).not.toHaveBeenCalled()
    w.rows[0]!.status = 'stopped'
    expect(await w.harness.talk('try again')).toMatchObject({ started: true, agentId: 'pair-2' })
    expect(w.deps.resume).not.toHaveBeenCalled()
    expect(w.deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'try again' }))
    w.rows[1]!.hasConversation = true
    expect(await w.harness.talk('now we can talk')).toMatchObject({ sent: true })
    expect(w.deps.send).toHaveBeenLastCalledWith('pair-2', 'now we can talk')
    await w.harness.off()
  })

  it('keeps one conversation and workspace for the collection, including after a restart', async () => {
    let uid = 'tim-one'
    const w = world({ pairedUid: () => uid, collectionUids: () => ['tim-one', 'tim-two'] })
    const first = await w.harness.talk('hello')
    expect(first).toMatchObject({ started: true, agentId: 'pair-1' })
    expect(w.deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: join(w.deps.workspace, 'collection-tim-one') }))
    uid = 'tim-two'
    expect(await w.harness.talk('a different little Tim')).toMatchObject({ sent: true, agentId: 'pair-1' })
    expect(w.rows.find(r => r.agentId === 'pair-1')?.status).toBe('live')
    uid = 'tim-one'
    expect(await w.harness.talk('remember me?')).toMatchObject({ sent: true, agentId: 'pair-1' })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
    expect(w.deps.send).toHaveBeenLastCalledWith('pair-1', 'remember me?')
    expect(w.harness.agentId()).toBe('pair-1')
    await w.harness.off()
    const restarted = new PairHarness(w.deps)
    expect(await restarted.talk('and after a restart?')).toMatchObject({ resumed: true, agentId: 'pair-1' })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
    await restarted.off()
  })

  it('never redirects a queued or stale-window message to a newly selected companion', async () => {
    let uid = 'tim-one'
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const w = world({ pairedUid: () => uid, engine: async () => { await ready; return 'opencode' } })
    expect(await w.harness.talk('for a different friend', 'tim-other')).toMatchObject({ error: 'STALE_COMPANION' })
    const pending = w.harness.talk('for Tim', 'tim-one')
    await Promise.resolve()
    uid = 'gnu-one'
    release()
    expect(await pending).toMatchObject({ error: 'STALE_COMPANION' })
    expect(w.deps.create).not.toHaveBeenCalled()
    expect(w.deps.send).not.toHaveBeenCalled()
  })

  it('DSH opening preserves live and paused history across character and package changes', async () => {
    let uid = 'tim-one'
    let name = 'Tim'
    const w = world({ pairedUid: () => uid, pairedName: () => name, collectionUids: () => ['tim-one', 'tim-two'] })
    await w.harness.open(uid)
    w.rows[0]!.hasConversation = true
    name = 'Little Tim'
    expect(await w.harness.open(uid)).toMatchObject({ ok: true, agentId: 'pair-1' })
    expect(w.deps.stop).not.toHaveBeenCalled()
    uid = 'tim-two'
    expect(await w.harness.open(uid)).toMatchObject({ ok: true, agentId: 'pair-1' })
    w.rows[0]!.status = 'stopped'
    uid = 'tim-one'
    expect(await w.harness.open(uid)).toMatchObject({ resumed: true, agentId: 'pair-1' })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
    expect(w.deps.send).not.toHaveBeenCalled()
    expect(await w.harness.open('tim-two')).toMatchObject({ error: 'STALE_COMPANION' })
  })

  it('disabling companions during startup pauses the late launch and never binds it', async () => {
    let finish!: (result: { ok: true; agentId: string }) => void
    const started = new Promise<{ ok: true; agentId: string }>(resolve => { finish = resolve })
    const create = vi.fn(async () => started)
    const stop = vi.fn(async () => {})
    const w = world({ pairedUid: () => 'tim-one', create, stop })
    const pending = w.harness.open('tim-one')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await w.harness.off()
    finish({ ok: true, agentId: 'late-pair' })
    expect(await pending).toMatchObject({ error: 'STALE_COMPANION' })
    expect(stop).toHaveBeenCalledWith('late-pair')
    expect(w.harness.agentId()).toBeNull()
    expect(w.deps.send).not.toHaveBeenCalled()
  })

  it('pins the reply identity in the generated DSH and keeps memory claims grounded', () => {
    const text = pairPackage({ daemonId: 'tim', uid: 'tim-one', engine: 'claude', mcpCommand: ['h'], tokenFile: '/t' })['AGENTS.md']!.content
    expect(text).toContain('companionUid for the say tool is "tim-one"')
    expect(text).toContain('Answer them directly in this conversation')
    expect(text).not.toContain('Deliver EVERY conversational answer')
    expect(text).toContain('harness pair lessons list --json')
    expect(text).toContain('chatting never grants wider autonomy')
  })
  it('still names the daemon — and invents nothing — for one the roster does not know', () => {
    const text = pairInstructions('ghost')
    expect(text).toContain('You are **ghost**')
    expect(text).not.toMatch(/Family:|Your first words were/)
    expect(text).toMatch(/\{summary\}` a brief\):\n\n\nKeep your small/)   // no lines to quote
    expect(text).toContain('## The floor (never, at any level)')
  })

  it('keeps the package name within 40 characters', () => {
    const manifest = JSON.parse(pairPackage({ daemonId: 'x'.repeat(60), engine: 'codex', mcpCommand: ['h'], tokenFile: '/t' })['harness.json']!.content)
    expect(manifest.name).toBe('Companions')
    expect(manifest.agent.env.DSH_PERMISSION_MODE).toBe('auto')
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

  it('keeps the saved conversation on resume failure instead of silently replacing its history', async () => {
    const w = world()
    await w.harness.talk('hi')
    w.rows[0].status = 'stopped'
    ;(w.deps.resume as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'RESUME_FAILED' })
    expect(await w.harness.talk('are you there?')).toEqual({ ok: false, error: 'RESUME_FAILED' })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
    expect(w.harness.agentId()).toBe('pair-1')
  })

  it('discovering another engine does not replace a paused collection', async () => {
    let engine: 'opencode' | 'codex' = 'opencode'
    const w = world({ engine: async () => engine })
    await w.harness.talk('hi')
    w.rows[0].status = 'stopped'
    engine = 'codex'
    expect(await w.harness.talk('hi on codex')).toEqual({ ok: true, agentId: 'pair-1', resumed: true })
    expect(w.deps.stop).not.toHaveBeenCalled()
    expect(w.deps.resume).toHaveBeenCalledWith('pair-1')
  })

  it('a package revision does not attempt to stop or replace a live collection', async () => {
    let engine: 'opencode' | 'codex' = 'opencode'
    const w = world({ engine: async () => engine, stop: vi.fn(async () => { throw new Error('busy') }) })
    await w.harness.talk('hi')
    engine = 'codex'
    expect(await w.harness.talk('hi on codex')).toMatchObject({ ok: true, sent: true, agentId: 'pair-1' })
    expect(w.deps.stop).not.toHaveBeenCalled()
  })
})

describe('the saved state', () => {
  it('adopts the selected legacy chat, preserves both archives, and changes persona without a new turn', async () => {
    let uid = 'tim-one'
    let daemon = 'tim'
    const w = world({ pairedUid: () => uid, pairedDaemon: () => daemon,
      collectionUids: () => ['tim-one', 'gnu-one'], engine: vi.fn(async () => null) })
    const tim = { agentId: 'old-tim', revision: 'old', uid: 'tim-one' }
    const gnu = { agentId: 'old-gnu', revision: 'old', uid: 'gnu-one' }
    mkdirSync(join(dir, 'pair'), { recursive: true })
    writeFileSync(w.deps.stateFile, JSON.stringify({ ...tim, conversations: { 'tim-one': tim, 'gnu-one': gnu } }))
    w.rows.push({ agentId: 'old-tim', engine: 'claude', status: 'live' }, { agentId: 'old-gnu', engine: 'codex', status: 'stopped' })
    expect(await w.harness.open(uid)).toEqual({ ok: true, agentId: 'old-tim' })
    uid = 'gnu-one'; daemon = 'gnu'
    expect(await w.harness.open(uid)).toEqual({ ok: true, agentId: 'old-tim' })
    expect(w.harness.context('old-tim')).toContain('selected gnu (gnu)')
    expect(w.harness.context('old-tim')).toContain('"gnu-one"')
    expect(w.harness.context('old-gnu')).toBeNull()
    expect(w.deps.create).not.toHaveBeenCalled()
    expect(w.deps.engine).not.toHaveBeenCalled()
    expect(w.deps.send).not.toHaveBeenCalled()
    expect(w.deps.stop).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(w.deps.stateFile, 'utf8')).conversations).toEqual({ 'tim-one': tim, 'gnu-one': gnu })
    expect(new PairHarness(w.deps).agentId()).toBe('old-tim')
  })

  it('never adopts a chat from another collection or signed-out guest', async () => {
    let uid = 'alice-tim'
    let members = ['alice-tim', 'alice-gnu']
    const w = world({ pairedUid: () => uid, collectionUids: () => members })
    await w.harness.open()
    uid = 'bob-tim'; members = ['bob-tim']
    expect(w.harness.agentId()).toBeNull()
    expect(w.harness.context('pair-1')).toBeNull()
    expect(await w.harness.open()).toMatchObject({ started: true, agentId: 'pair-2' })
    uid = 'alice-gnu'; members = ['alice-tim', 'alice-gnu']
    expect(w.harness.agentId()).toBe('pair-1')
    expect(await w.harness.open()).toEqual({ ok: true, agentId: 'pair-1', resumed: true })
    members = []
    expect(w.harness.agentId()).toBeNull()
  })

  it('does not replace a saved conversation whose registry row is temporarily missing', async () => {
    const w = world()
    await w.harness.open()
    w.rows.length = 0
    expect(await w.harness.open()).toMatchObject({ error: 'CONVERSATION_UNAVAILABLE' })
    expect(w.deps.create).toHaveBeenCalledTimes(1)
  })

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
