import { releaseRegistryEngine, removeRegistryAgent } from '../testing/registryFixtures.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, constants, openSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'
import type { ChildProcess } from 'node:child_process'

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, openSync: vi.fn(fs.openSync), readFileSync: vi.fn(fs.readFileSync) } })

let directory = ''
// The first import compiles registry.js's whole module graph: seconds on a loaded Mac. Paid once here, it stays out of the
// first test's 5 s; each test's own import after resetModules only runs the compiled modules again.
beforeAll(async () => {
  await import('./stoppedAgents.js')
}, 60_000)
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-stopped-'))
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
})
afterEach(async () => {
  await (await import('./registry.js')).registry.flush()
  await (await import('./sessionStorage.js')).sessionStorage.close()
  vi.mocked(openSync).mockRestore()
  vi.mocked(readFileSync).mockRestore()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('saved catalog reads', () => {
  it('fails a disconnected listing visibly and freshly reads every row after child replacement', async () => {
    const { saved, store } = await fixture()
    await store.save(saved)
    await store.save({ ...saved, agentId: 'peer', title: 'Peer' })
    const { sessionStorage } = await import('./sessionStorage.js')
    const child = (sessionStorage as unknown as { child: ChildProcess }).child
    const send = child.send.bind(child)
    let stopped = false
    child.send = ((...args: Parameters<typeof child.send>) => {
      if (!stopped) { stopped = true; child.kill('SIGKILL') }
      return send(...args)
    }) as typeof child.send
    await expect(store.list()).rejects.toMatchObject({ code: 'disconnected' })
    expect((await store.list()).map(row => row.agentId).sort()).toEqual([saved.agentId, 'peer'].sort())
    expect((sessionStorage as unknown as { child: ChildProcess }).child.pid).not.toBe(child.pid)
  })

  it('lists the previous published row while a new image is prepared, then the settled row', async () => {
    const { saved, store } = await fixture()
    await store.save(saved)
    const { sessionStorage } = await import('./sessionStorage.js')
    const prepare = sessionStorage.prepare.bind(sessionStorage)
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const paused = vi.spyOn(sessionStorage, 'prepare').mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      entered(); await held
      return prepared
    })
    const writing = store.save({ ...saved, title: 'Settled title' })
    try {
      await arrived
      expect((await store.list())[0].title).toBe(saved.title)
      release(); await writing
      expect((await store.list())[0].title).toBe('Settled title')
    } finally { release(); await writing; paused.mockRestore() }
  })

  it('selects only matching conversations in storage, including the explicit default profile', async () => {
    vi.stubEnv('CODEX_HOME', join(directory, 'profile'))
    const { saved, store } = await fixture()
    const { conversationKey } = await import('./conversationIdentity.js')
    const selected = { ...saved, engine: 'codex' as const, sessionId: 'selected', codexHome: null }
    await store.save(selected)
    await store.save({ ...selected, agentId: 'explicit', codexHome: join(directory, 'profile') })
    await store.save({ ...selected, agentId: 'foreign-profile', codexHome: join(directory, 'elsewhere') })
    for (let i = 0; i < 4; i++) await store.save({ ...selected, agentId: `unrelated-${i}`, sessionId: `other-${i}` })
    const list = vi.spyOn(store, 'list').mockRejectedValue(new Error('Keyed reconciliation must not list the archive in core'))
    const rows = await store.selectConversations([conversationKey(selected)!])
    expect(rows.map(row => row.agentId).sort()).toEqual([saved.agentId, 'explicit'].sort())
    expect(rows.every(row => store.current(row))).toBe(true)
    expect(list).not.toHaveBeenCalled()
    list.mockRestore()
  })

  it('saves a held conversation without persisting its transient identity verdict', async () => {
    const { saved, store } = await fixture()
    ;(await store.save({ ...saved, identityHold: 'The session-home catalog is unavailable.', evidenceRevision: 3, interpretationHold: 'pending', admissionHold: 'Waiting for native source' }))
    const raw = JSON.parse(readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8'))
    expect(raw.session.sessionId).toBe(saved.sessionId)
    expect(raw.session).not.toHaveProperty('identityHold')
    expect(raw.session).not.toHaveProperty('admissionHold')
    expect(raw.session).not.toHaveProperty('interpretationHold')
    expect(raw.session).not.toHaveProperty('evidenceRevision')
    expect((await store.get(saved.agentId))).not.toHaveProperty('identityHold')
  })

  it('reads every fresh catalog through storage without reading its content in core', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const first = (await store.list())
    vi.mocked(readFileSync).mockClear()
    for (let i = 0; i < 20; i++) expect((await store.available([]))).toEqual(first)
    expect(readFileSync).not.toHaveBeenCalled()
    expect((await store.get(saved.agentId))).toEqual(first[0])
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('keeps returned records private and filters the current live inventory on every call', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const [first] = (await store.list())
    first.title = 'A caller changed this'
    first.runtimes[0].paneId = '%999'
    first.processIdentity!.pid = 1
    expect((await store.list())[0]).toMatchObject({ title: saved.title, runtimes: saved.runtimes, processIdentity: saved.processIdentity })
    expect((await store.available([saved]))).toEqual([])
    expect((await store.available([]))).toHaveLength(1)
  })

  it('periodically revalidates file contents and refreshes after a backwards clock change', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      ;(await store.list())
      vi.mocked(readFileSync).mockClear()
      clock.mockReturnValue(now + 30_000)
      expect((await store.list())).toHaveLength(1)
      expect(readFileSync).not.toHaveBeenCalled()
      vi.mocked(readFileSync).mockClear()
      clock.mockReturnValue(now - 1)
      expect((await store.list())).toHaveLength(1)
      expect(readFileSync).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it('sees saves, patches, external replacements, in-place edits and deletion immediately', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    ;(await store.list())
    ;(await store.patch(saved.agentId, { cwd: '/changed' }))
    expect((await store.list())[0].cwd).toBe('/changed')
    ;(await store.save({ ...saved, title: 'Updated title' }))
    expect((await store.list())[0].title).toBe('Updated title')
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const replacement = `${file}.tmp`
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.session.title = 'External edit'
    writeFileSync(replacement, JSON.stringify(raw), { mode: 0o600 })
    renameSync(replacement, file)
    expect((await store.list())[0].title).toBe('External edit')
    const before = statSync(file)
    raw.session.title = 'External next' // Same length; restoring mtime must not conceal the edit.
    writeFileSync(file, JSON.stringify(raw))
    utimesSync(file, before.atime, before.mtime)
    expect((await store.list())[0].title).toBe('External next')
    rmSync(file)
    expect((await store.list())).toEqual([])
    ;(await store.save(saved))
    expect((await store.list())[0].sessionId).toBe(saved.sessionId)
  })

  it('drops a warmed record when corrupted, unsafe, or replaced by a symlink', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const raw = readFileSync(file, 'utf8')
    ;(await store.list())
    writeFileSync(file, '{')
    expect((await store.list())).toEqual([])
    writeFileSync(file, raw)
    expect((await store.list())).toHaveLength(1)
    chmodSync(file, 0o666)
    expect((await store.list())).toEqual([])
    await expect(store.get(saved.agentId)).rejects.toThrow()
    chmodSync(file, 0o600)
    expect((await store.list())).toHaveLength(1)
    rmSync(file)
    const target = join(directory, 'other.json')
    writeFileSync(target, raw, { mode: 0o600 })
    symlinkSync(target, file)
    expect((await store.list())).toEqual([])
    await expect(store.get(saved.agentId)).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe(raw)
    chmodSync(join(directory, 'stopped-agents'), 0o777)
    await expect(store.list()).rejects.toThrow()
  })

  it('does not lend a selected image proof to a replacement archive', async () => {
    const { saved, store } = await fixture()
    await store.save(saved)
    const selected = (await store.get(saved.agentId))!
    expect(store.current(selected)).toBe(true)
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.session.title = 'Replacement'
    const replacement = `${file}.tmp`
    writeFileSync(replacement, JSON.stringify(raw), { mode: 0o600 })
    renameSync(replacement, file)
    expect(store.current(selected)).toBe(false)
    expect((await store.get(saved.agentId))!.title).toBe('Replacement')
  })

  it('keeps every supported large record visible without a core content cache', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const base = join(directory, 'stopped-agents')
    rmSync(join(base, `${saved.agentId}.json`))
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(base, `large-${i}.json`), JSON.stringify({ version: 1,
        session: { ...saved, agentId: `large-${i}`, title: 'x'.repeat(512 * 1024) } }), { mode: 0o600 })
    }
    expect((await store.list())).toHaveLength(10)
    vi.mocked(readFileSync).mockClear()
    expect((await store.list())).toHaveLength(10)
    expect(readFileSync).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) rmSync(join(base, `large-${i}.json`))
    expect((await store.list())).toEqual([])
    ;(await store.save(saved))
    ;(await store.list())
    vi.mocked(readFileSync).mockClear()
    expect((await store.list())).toHaveLength(1)
    expect(readFileSync).not.toHaveBeenCalled()
  })


})

async function fixture() {
  const { registry } = await import('./registry.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const entry = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: '/tmp/work', defaultName: 'My work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan' }))!
  const saved: RegisteredSession = { ...entry, sessionId: 'conversation-123', title: 'Continue my work', processIdentity: { pid: 98765, executable: 'codex', startMarker: 'old-process' } }
  const store = new StoppedAgentStore(join(directory, 'stopped-agents'))
  return { registry, StoppedAgentStore, saved, store }
}

describe('stopped harness persistence', () => {
  it('retains the conversation and launch profile after removal and store reload', async () => {
    const { registry, StoppedAgentStore, saved, store } = await fixture()
    ;(await store.save(saved))
    ;(await removeRegistryAgent(registry, saved.agentId))
    const restored = (await new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId))!
    expect(restored).toMatchObject({ agentId: saved.agentId, sessionId: 'conversation-123', engine: 'codex', cwd: '/tmp/work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan', active: false })
    expect(registry.list()).toHaveLength(0)
    expect(registry.advertised()).toHaveLength(0)
    expect((await store.available([]))).toHaveLength(1)
    expect(statSync(join(directory, 'stopped-agents', `${saved.agentId}.json`)).mode & 0o777).toBe(0o600)
  })

  // A launch that failed for a named reason started nothing: its archive is where `harness ps --all` and `show` read why.
  it('keeps a failed launch and its reason, and saves any other launch as ready', async () => {
    const { saved, store } = await fixture()
    const failed = { state: 'failed', error: 'OPENCLAW_FOLDER_GONE', detail: "This run's OpenClaw folder is gone." } as const
    ;(await store.save({ ...saved, launch: failed }))
    expect((await store.get(saved.agentId))!.launch).toEqual(failed)
    ;(await store.save({ ...saved, launch: { state: 'held', service: 'models', detail: 'Waiting for models.' } }))
    expect((await store.get(saved.agentId))!.launch).toEqual({ state: 'ready' })
    // Not confirmed is not failed: its engine may have run, and a stopped harness has no terminal to check.
    ;(await store.save({ ...saved, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED', detail: 'Check the terminal.' } }))
    expect((await store.get(saved.agentId))!.launch).toEqual({ state: 'ready' })
  })

  it('patches one field of an archive without touching its name or activity time', async () => {
    const { saved, store } = await fixture()
    ;(await store.save({ ...saved, defaultName: 'harness Desktop' }))
    const before = (await store.get(saved.agentId))!
    expect((await store.patch(saved.agentId, { cwd: '/tmp/work-repaired' }))).toBe(true)
    const after = (await store.get(saved.agentId))!
    expect(after).toEqual({ ...before, cwd: '/tmp/work-repaired' })
    expect(after.touchedAt).toBe(before.touchedAt)
    expect(after.defaultName).toBe('harness Desktop')
    expect((await store.patch('never-saved', { cwd: '/tmp' }))).toBe(false)
  })

  // A stopped shell that is opened again is a new pane: the agent that ended in its old one is nobody's to take.
  it('a saved record never keeps previousAgentId', async () => {
    const { saved, store } = await fixture()
    ;(await store.save({ ...saved, previousAgentId: 'agent-that-ended' }))
    const file = JSON.parse(readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8')) as { session: Record<string, unknown> }
    expect(file.session).not.toHaveProperty('previousAgentId')
    expect((await store.get(saved.agentId))).not.toHaveProperty('previousAgentId')
  })

  // The folder a Claude row drifted out of is corrected in place (cwdRepair.ts).
  it('patch corrects the folder in place: the name and touchedAt stay, and an id with no record answers false', async () => {
    const { saved, store } = await fixture()
    ;(await store.save({ ...saved, defaultName: 'harness Desktop' }))
    const before = (await store.get(saved.agentId))!
    expect((await store.patch(saved.agentId, { cwd: '/elsewhere' }))).toBe(true)
    const after = (await store.get(saved.agentId))!
    expect(after).toEqual({ ...before, cwd: '/elsewhere' })
    expect(after.touchedAt).toBe(before.touchedAt)
    expect(after.defaultName).toBe('harness Desktop')
    expect((await store.patch('never-saved', { cwd: '/elsewhere' }))).toBe(false)
  })

  // The global "last used" order must not forget an agent because it was paused: the archive keeps
  // the stamp, the store reads it back, and the resumed row carries it into the live registry.
  it('keeps when an app last opened the agent through a stop and a resume', async () => {
    const { registry, StoppedAgentStore, saved, store } = await fixture()
    const opened = registry.markOpened(saved.agentId)!.lastOpenedAt!
    expect(opened).toBeGreaterThan(0)
    ;(await store.save({ ...registry.byAgent(saved.agentId)!, sessionId: saved.sessionId }))
    ;(await removeRegistryAgent(registry, saved.agentId))
    const archived = (await new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId))!
    expect(archived.lastOpenedAt).toBe(opened)
    const resumed = (await registry.resumePendingAgent(archived, [{ backend: 'tmux', paneId: '%77' }]))!
    expect(resumed.lastOpenedAt).toBe(opened)
    expect(registry.byAgent(saved.agentId)?.lastOpenedAt).toBe(opened)
  })

  it('the archive keeps a local row\'s folder and its earlier session keys', async () => {
    const { registry, StoppedAgentStore, store } = await fixture()
    const local = (await registry.openPendingAgent({ engine: 'openclaw', runtimes: [{ backend: 'tmux', paneId: '%11' }], cwd: '/tmp/work', openclawLocal: '/run/skill-1' }))!
    ;(await store.save({ ...local, sessionId: 'agent:main:tui-2', earlierSessionIds: ['agent:main:harness-1'], active: false }))
    expect((await new StoppedAgentStore(join(directory, 'stopped-agents')).get(local.agentId))).toMatchObject({
      openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1', earlierSessionIds: ['agent:main:harness-1'] })
  })

  it('T1 keeps a fork origin with its parent session through save, get and list', async () => {
    const { registry, StoppedAgentStore, store } = await fixture()
    const origin = { agentId: 'p', name: 'Parent', sessionId: 'p-sess', transcriptPath: '/x/p-sess.jsonl' }
    const fork = (await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%9' }], cwd: '/tmp/work', forkedFrom: origin }))!
    ;(await store.save({ ...fork, sessionId: 'fork-sess', active: false }))
    const fresh = new StoppedAgentStore(join(directory, 'stopped-agents'))
    expect((await fresh.get(fork.agentId))?.forkedFrom).toEqual(origin)
    expect((await fresh.list()).find(row => row.agentId === fork.agentId)?.forkedFrom).toEqual(origin)
  })

  it('reads a stopped fork saved by an older daemon, and drops a malformed origin without failing the read', async () => {
    const { registry, StoppedAgentStore, store } = await fixture()
    const fork = (await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%10' }], cwd: '/tmp/work',
      forkedFrom: { agentId: 'p', name: 'Parent' } }))!
    ;(await store.save({ ...fork, active: false }))
    const file = join(directory, 'stopped-agents', `${fork.agentId}.json`)
    const rewrite = (forkedFrom: unknown) => {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      record.session.forkedFrom = forkedFrom
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
    }
    const fresh = () => new StoppedAgentStore(join(directory, 'stopped-agents'))
    expect((await fresh().get(fork.agentId))?.forkedFrom).toEqual({ agentId: 'p', name: 'Parent' })
    rewrite({ agentId: 'p', name: 'Parent', sessionId: 'p-sess', transcriptPath: 'relative.jsonl', extra: 'x' })
    expect((await fresh().get(fork.agentId))?.forkedFrom).toEqual({ agentId: 'p', name: 'Parent', sessionId: 'p-sess' })
    rewrite({ agentId: 7 })
    const malformed = (await fresh().get(fork.agentId))
    expect(malformed?.agentId).toBe(fork.agentId)
    expect(malformed && 'forkedFrom' in malformed).toBe(false)
    expect((await fresh().list()).find(row => row.agentId === fork.agentId)).toBeTruthy()
  })

  // Another harness took its conversation (core/agents/conversationOwners.ts): moved aside, never deleted.
  it('sets a record aside, with its reservation, and lists it no more', async () => {
    const { StoppedAgentStore, saved, store } = await fixture()
    ;(await store.save(saved))
    expect(store.beginResume(saved.agentId)).toBeTruthy()
    const before = readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8')
    expect((await store.list())).toHaveLength(1)
    expect((await store.supersede(saved.agentId))).toMatchObject({ agentId: saved.agentId, sessionId: 'conversation-123' })
    expect(readFileSync(join(directory, 'stopped-agents', 'superseded', `${saved.agentId}.json`), 'utf8')).toBe(before)
    expect(statSync(join(directory, 'stopped-agents', 'superseded')).mode & 0o777).toBe(0o700)
    expect(store.resumeReservedAt(saved.agentId)).toBeNull()
    expect((await store.get(saved.agentId))).toBeNull()
    expect((await store.list())).toEqual([])
    expect(store.ids()).toEqual([])
    expect((await new StoppedAgentStore(join(directory, 'stopped-agents')).list())).toEqual([])
    // Nothing to set aside: an unsafe id, an absent record, one already set aside.
    expect((await store.supersede('../escape'))).toBeNull()
    expect((await store.supersede('never-saved'))).toBeNull()
    expect((await store.supersede(saved.agentId))).toBeNull()
  })

  it('hides a running identity or conversation, without discarding its archive', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    expect((await store.available([saved]))).toEqual([])
    expect((await store.available([{ ...saved, agentId: 'another-agent' }]))).toEqual([])
    expect((await store.available([{ ...saved, agentId: 'another-agent', codexHome: '/other/profile' }]))).toHaveLength(1)
    expect((await store.available([]))).toHaveLength(1)
  })

  it.each([true, false])('hides a live Codex conversation across explicit and implicit default profiles, archived explicit=%s', async explicit => {
    const { saved, store } = await fixture()
    const { env } = await import('../config/env.js')
    const defaultHome = join(env.CODEX_HOME, '.')
    ;(await store.save({ ...saved, engine: 'codex', codexHome: explicit ? defaultHome : null }))
    const running = { ...saved, engine: 'codex' as const, agentId: 'replacement', codexHome: explicit ? null : defaultHome }
    expect((await store.available([running]))).toEqual([])
    expect((await store.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
    expect((await store.available([{ ...running, codexHome: '/another/codex-profile' }]))).toHaveLength(1)
  })

  it('stopping the shell left by an exited engine preserves its conversation', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    ;(await store.save({ ...saved, engine: 'terminal', sessionId: '', codexHome: null, dsh: null }))
    expect((await store.get(saved.agentId))).toMatchObject({ engine: 'codex', sessionId: 'conversation-123', codexHome: '/tmp/profile' })
  })

  it('resumes on a new route with the same identity and refuses a duplicate claim', async () => {
    const { registry, saved, store } = await fixture()
    ;(await store.save(saved))
    ;(await removeRegistryAgent(registry, saved.agentId))
    const resumed = (await registry.resumePendingAgent((await store.get(saved.agentId))!, [{ backend: 'tmux', paneId: '%99' }]))!
    expect(resumed).toMatchObject({ agentId: saved.agentId, sessionId: saved.sessionId, tmuxPane: '%99', processIdentity: null, launch: { state: 'starting' }, permissionMode: 'plan', codexHome: '/tmp/profile' })
    expect((await registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%100' }]))).toBeNull()
    expect(registry.advertised()).toHaveLength(1)
  })

  it('does not follow a planted archive symlink or overwrite unsafe state', async () => {
    const { saved, store } = await fixture()
    ;(await store.save(saved))
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const other = join(directory, 'other.json')
    writeFileSync(other, 'untouched', { mode: 0o600 })
    rmSync(file)
    symlinkSync(other, file)
    await expect(store.get(saved.agentId)).rejects.toThrow()
    await expect(store.save(saved)).rejects.toThrow()
    expect(readFileSync(other, 'utf8')).toBe('untouched')
    rmSync(file)
    ;(await store.save(saved))
    chmodSync(file, 0o666)
    await expect(store.get(saved.agentId)).rejects.toThrow()
  })
})


it('keeps the original identity searchable while preserving the surviving shell route', async () => {
  const { registry, saved, store } = await fixture()
  // Use the actual row, as the daemon does after registering its session.
  Object.assign(registry.byAgent(saved.agentId)!, saved)
  ;(await store.save(saved))
  const shell = (await releaseRegistryEngine(registry, saved.agentId, true))!
  expect(shell.agentId).not.toBe(saved.agentId)
  expect(shell).toMatchObject({ engine: 'terminal', sessionId: '', tmuxPane: '%8', processIdentity: null })
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(registry.bySession(saved.sessionId)).toBeUndefined()
  expect((await store.available(registry.list())).map(row => row.agentId)).toEqual([saved.agentId])
  const resumed = (await registry.resumePendingAgent((await store.get(saved.agentId))!, [{ backend: 'tmux', paneId: '%99' }]))!
  expect(resumed.agentId).toBe(saved.agentId)
  expect(registry.byRuntimeTerminal({ backend: 'tmux', paneId: '%8' })?.agentId).toBe(shell.agentId)
  expect(registry.list()).toHaveLength(2)
})

it('reserves allocation across daemon restarts and different receipt IDs', async () => {
  const { store, StoppedAgentStore, saved } = await fixture()
  const token = store.beginResume(saved.agentId)!
  const restarted = new StoppedAgentStore(join(directory, 'stopped-agents'))
  expect(restarted.beginResume(saved.agentId)).toBeNull()
  restarted.finishResume(saved.agentId, 'someone-else')
  expect(store.beginResume(saved.agentId)).toBeNull()
  restarted.finishResume(saved.agentId, token)
  expect(store.beginResume(saved.agentId)).not.toBeNull()
})

// A reservation left behind by a crash can be half-written, and that is exactly the one the
// age-based takeover in `resumeAgentService` has to be able to clear.
it('reports how long a reservation has been held, and clears a half-written one', async () => {
  const { store, saved } = await fixture()
  const before = Date.now()
  expect(store.resumeReservedAt(saved.agentId)).toBeNull()
  const token = store.beginResume(saved.agentId)!
  const held = store.resumeReservedAt(saved.agentId)
  expect(held).not.toBeNull()
  expect(held!).toBeGreaterThanOrEqual(before - 1000)

  writeFileSync(join(directory, 'stopped-agents', `${saved.agentId}.resume`), '{"token": "trunc')
  // A caller clearing ITS OWN reservation still has to read the marker to know it is its own.
  expect(() => store.finishResume(saved.agentId, token)).toThrow()
  expect(store.resumeReservedAt(saved.agentId)).not.toBeNull()
  // A caller taking it over is not asking whose it is.
  store.finishResume(saved.agentId)
  expect(store.resumeReservedAt(saved.agentId)).toBeNull()
  expect(store.beginResume(saved.agentId)).not.toBeNull()
})

it('keeps readable archives discoverable beside corrupt, unsupported and mismatched records', async () => {
  const { saved, store } = await fixture()
  expect((await store.list())).toEqual([])
  ;(await store.save(saved))
  const base = join(directory, 'stopped-agents')
  for (const [id, content] of Object.entries({ corrupt: '{', version: JSON.stringify({ version: 99 }), invalid: JSON.stringify({ version: 1, session: {} }), mismatch: JSON.stringify({ version: 1, session: saved }) })) {
    writeFileSync(join(base, `${id}.json`), content, { mode: 0o600 })
  }
  writeFileSync(join(base, 'unrelated.tmp'), 'skip')
  expect((await store.list()).map(row => row.agentId)).toEqual([saved.agentId])
  expect((await store.get('missing'))).toBeNull()
  expect((await store.get('../invalid'))).toBeNull()
  await expect(store.save({ ...saved, agentId: '../invalid' })).rejects.toThrow()
  expect(() => store.beginResume('../invalid')).toThrow()
  store.finishResume('../invalid')
  store.finishResume('absent')
  chmodSync(base, 0o777)
  await expect(store.list()).rejects.toThrow()
})

it('persists a standalone shell and a runtime without the legacy tmux alias', async () => {
  const { saved, store } = await fixture()
  ;(await store.save({ ...saved, engine: 'terminal', sessionId: '', tmuxPane: '', runtimes: [{ backend: 'unknown', endpointId: 'fixture', paneId: '1' } as any], primaryRuntimeKey: ['unknown', 'fixture', '1'].join('\0'), codexHome: null }))
  const disk = JSON.parse(readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8'))
  expect(disk.session).not.toHaveProperty('tmuxPane')
  expect(disk.session.sessionId).toBe('')
  ;(await store.save({ ...saved, agentId: 'null-profile', codexHome: null }))
  expect((await store.available([{ ...saved, agentId: 'live', codexHome: null }])).some(row => row.agentId === 'null-profile')).toBe(false)
  expect((await store.available([{ ...saved, sessionId: '' }]))).toBeDefined()
})

it('fails closed on corrupt reservation data and unsafe reservation files', async () => {
  const { saved, store } = await fixture()
  const token = store.beginResume(saved.agentId)!
  const marker = join(directory, 'stopped-agents', `${saved.agentId}.resume`)
  writeFileSync(marker, '{')
  expect(() => store.finishResume(saved.agentId, token)).toThrow()
  expect(store.beginResume(saved.agentId)).toBeNull()
  rmSync(marker)
  // A directory in place of the reservation cannot be unlinked as a file.
  symlinkSync('/dev/null', marker)
  expect(() => store.finishResume(saved.agentId)).toThrow()
  rmSync(marker)
  // Fail before allocation if private-state traversal itself is unsafe.
  chmodSync(join(directory, 'stopped-agents'), 0o777)
  expect(() => store.beginResume(saved.agentId)).toThrow()
})

it('does not allocate when reserving disk space fails', async () => {
  const { saved, store } = await fixture()
  ;(await store.save(saved))
  const real = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(openSync).mockImplementation((file, flags, mode) => {
    if (typeof flags === 'number' && (flags & constants.O_EXCL)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return real.openSync(file, flags, mode)
  })
  expect(() => store.beginResume(saved.agentId)).toThrow('disk full')
  expect((await store.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
})

it('an unbound observation of the same process keeps its confirmed conversation', async () => {
  const { saved, store } = await fixture()
  saved.transcriptPath = '/history.jsonl'; saved.boundAt = 1; saved.source = 'hook'; (await store.save(saved))
  ;(await store.save({ ...saved, sessionId: '', transcriptPath: null, title: 'Renamed', boundAt: null, source: null }))
  expect((await store.get(saved.agentId))).toMatchObject({ sessionId: saved.sessionId, transcriptPath: '/history.jsonl', title: 'Renamed', boundAt: 1, source: 'hook' })
})
it.each(['same', 'missing', 'different'] as const)('preserves an unbound Hermes conversation only with a compatible home: %s', async mode => {
  const { saved, store } = await fixture()
  Object.assign(saved, { engine: 'hermes', hermesHome: '/fixture/hermes' })
  ;(await store.save(saved))
  const hermesHome = mode === 'missing' ? undefined : mode === 'same' ? saved.hermesHome : '/fixture/other-hermes'
  ;(await store.save({ ...saved, sessionId: '', transcriptPath: null, hermesHome }))
  expect((await store.get(saved.agentId))).toMatchObject({
    sessionId: mode === 'different' ? '' : saved.sessionId,
    hermesHome: mode === 'different' ? hermesHome : saved.hermesHome,
  })
})
it('an unbound Hermes observation with no home keeps the saved home with the mark it was saved with', async () => {
  const { saved, store } = await fixture()
  Object.assign(saved, { engine: 'hermes', hermesHome: '/fixture/sandbox/.hermes', hermesHomeDerived: true })
  ;(await store.save(saved))
  const { hermesHome: _home, hermesHomeDerived: _mark, ...unbound } = saved
  ;(await store.save({ ...unbound, sessionId: '', transcriptPath: null }))
  // Without the mark, a resume would export the daemon's path of a home Harness worked out (registry.ts hermesHomeDerived).
  expect((await store.get(saved.agentId))).toMatchObject({ sessionId: saved.sessionId, hermesHome: '/fixture/sandbox/.hermes', hermesHomeDerived: true })
})
it('a pathless observation of the same conversation keeps its captured native path', async () => {
  const { saved, store } = await fixture()
  saved.hermesHome = '/fixture/hermes'
  ;(await store.save({ ...saved, transcriptPath: '/history.jsonl', source: 'stop-repair' }))
  ;(await store.save({ ...saved, transcriptPath: null, title: 'A newer title', source: 'hook' }))
  expect((await store.get(saved.agentId))).toMatchObject({ sessionId: saved.sessionId,
    transcriptPath: '/history.jsonl', title: 'A newer title', source: 'hook' })
  ;(await store.save({ ...saved, transcriptPath: '/replacement.jsonl' }))
  expect((await store.get(saved.agentId))?.transcriptPath).toBe('/replacement.jsonl')
})
it.each(['agent', 'conversation', 'engine', 'registration', 'profile', 'hermes home', 'missing process', 'pid', 'start', 'ticks', 'executable'])
('never transfers a captured path across a changed identity: %s', async mode => {
  const { saved, store } = await fixture()
  saved.processIdentity!.startTicks = 100
  ;(await store.save({ ...saved, transcriptPath: '/history.jsonl' }))
  const next: RegisteredSession = { ...saved, transcriptPath: null, processIdentity: { ...saved.processIdentity! } }
  if (mode === 'agent') next.agentId = 'another-agent'
  if (mode === 'conversation') next.sessionId = 'another-conversation'
  if (mode === 'engine') next.engine = 'claude'
  if (mode === 'registration') next.registeredAt++
  if (mode === 'profile') next.codexHome = '/another/profile'
  if (mode === 'hermes home') next.hermesHome = '/another/hermes'
  if (mode === 'missing process') next.processIdentity = null
  if (mode === 'pid') next.processIdentity!.pid++
  if (mode === 'start') { delete next.processIdentity!.startTicks; next.processIdentity!.startMarker = 'new' }
  if (mode === 'ticks') next.processIdentity!.startTicks = 200
  if (mode === 'executable') next.processIdentity!.executable = 'other'
  ;(await store.save(next))
  expect((await store.get(next.agentId))?.transcriptPath).toBeNull()
})
it.each(['engine', 'missing', 'previous missing', 'pid', 'start', 'executable'])('does not transfer a binding to a different process: %s', async mode => {
  const { saved, store } = await fixture()
  ;(await store.save(mode === 'previous missing' ? { ...saved, processIdentity: null } : saved))
  const next = { ...saved, sessionId: '', processIdentity: { ...saved.processIdentity! } } as RegisteredSession
  if (mode === 'engine') next.engine = 'claude'
  if (mode === 'missing') next.processIdentity = null
  if (mode === 'pid') next.processIdentity!.pid++
  if (mode === 'start') next.processIdentity!.startMarker = 'new'
  if (mode === 'executable') next.processIdentity!.executable = 'other'
  ;(await store.save(next)); expect((await store.get(saved.agentId))?.sessionId).toBe('')
})

it('lists the id of every saved record, unreadable ones included, and none before the folder exists', async () => {
  const { saved, store } = await fixture()
  expect(store.ids()).toEqual([])
  ;(await store.save(saved))
  writeFileSync(join(directory, 'stopped-agents', 'broken.json'), '{not json')
  expect(store.ids().sort()).toEqual([saved.agentId, 'broken'].sort())
  expect((await store.list()).map((s) => s.agentId)).toEqual([saved.agentId])
})

// The handoff asks whether any stopped record holds a conversation (handoffDiscovery `ownedByOther`) and
// fails closed when it cannot tell. An unreadable folder answered "no records" would let a handoff bind a
// conversation a stopped harness still owns.
it('says it cannot list the records when the folder cannot be read, never that there are none', async () => {
  const { saved, store } = await fixture()
  ;(await store.save(saved))
  chmodSync(join(directory, 'stopped-agents'), 0o000)
  try {
    // Root reads through any mode: there is no unreadable folder to show.
    if (process.getuid?.() !== 0) expect(() => store.ids()).toThrow(expect.objectContaining({ code: 'EACCES' }))
  } finally { chmodSync(join(directory, 'stopped-agents'), 0o700) }
  // A file where the folder should be is not "none yet" either.
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  expect(() => new StoppedAgentStore(join(directory, 'stopped-agents', `${saved.agentId}.json`))).toThrow('invalid')
})

// Purging a stopped harness's saved session (purgeAgentService) is the one permanent deletion: Stop keeps
// the record, this removes it.
it('permanently deletes a stopped record, at once for every reader, and refuses an identity that is not one', async () => {
  const { saved, StoppedAgentStore, store } = await fixture()
  ;(await store.save(saved))
  ;(await store.save({ ...saved, agentId: 'kept' }))
  // Warm the catalog, as a status snapshot does: the deletion must not be served from it afterwards.
  expect((await store.list()).map((row) => row.agentId).sort()).toEqual([saved.agentId, 'kept'].sort())
  ;(await store.remove(saved.agentId))
  expect((await store.get(saved.agentId))).toBeNull()
  expect((await store.list()).map((row) => row.agentId)).toEqual(['kept'])
  expect(store.ids()).toEqual(['kept'])
  expect((await new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId))).toBeNull()
  // Removing it again, or one never saved, is nothing to do; a path is never an identity.
  await expect(store.remove(saved.agentId)).resolves.toBeUndefined()
  await expect(store.remove('never-saved')).resolves.toBeUndefined()
  await expect(store.remove('../kept')).rejects.toThrow('Invalid stopped harness identity.')
  expect((await store.get('kept'))?.agentId).toBe('kept')
})

// Only a harness identity names a record: a name in the folder that is not one is never read as a saved
// harness, and an identity that is a path never reaches outside the folder.
it('lists only files named by a harness identity, and never looks outside its folder for a reservation', async () => {
  const { saved, store } = await fixture()
  ;(await store.save(saved))
  const base = join(directory, 'stopped-agents')
  writeFileSync(join(base, 'not an id.json'), JSON.stringify({ version: 1, session: { ...saved, agentId: 'not an id' } }), { mode: 0o600 })
  expect((await store.list()).map((row) => row.agentId)).toEqual([saved.agentId])
  // A reservation beside the folder, where `../escape` would point.
  writeFileSync(join(directory, 'escape.resume'), '{}', { mode: 0o600 })
  expect(store.resumeReservedAt('../escape')).toBeNull()
  expect(store.resumeReservedAt(saved.agentId)).toBeNull()
})
