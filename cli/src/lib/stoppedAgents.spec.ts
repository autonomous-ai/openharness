import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, constants, openSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, openSync: vi.fn(fs.openSync), readFileSync: vi.fn(fs.readFileSync) } })

let directory = ''
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-stopped-'))
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
})
afterEach(() => {
  vi.mocked(openSync).mockRestore()
  vi.mocked(readFileSync).mockRestore()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('saved catalog reads', () => {
  it('does not reread unchanged records for status snapshots, but resume still reads the file', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const first = store.list()
    vi.mocked(readFileSync).mockClear()
    for (let i = 0; i < 20; i++) expect(store.available([])).toEqual(first)
    expect(readFileSync).not.toHaveBeenCalled()
    expect(store.get(saved.agentId)).toEqual(first[0])
    expect(readFileSync).toHaveBeenCalledTimes(1)
  })

  it('keeps cached records private and filters the current live inventory on every call', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const [first] = store.list()
    first.title = 'A caller changed this'
    first.runtimes[0].paneId = '%999'
    first.processIdentity!.pid = 1
    expect(store.list()[0]).toMatchObject({ title: saved.title, runtimes: saved.runtimes, processIdentity: saved.processIdentity })
    expect(store.available([saved])).toEqual([])
    expect(store.available([])).toHaveLength(1)
  })

  it('periodically revalidates file contents and refreshes after a backwards clock change', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      store.list()
      vi.mocked(readFileSync).mockClear()
      clock.mockReturnValue(now + 30_000)
      expect(store.list()).toHaveLength(1)
      expect(readFileSync).toHaveBeenCalledTimes(1)
      vi.mocked(readFileSync).mockClear()
      clock.mockReturnValue(now - 1)
      expect(store.list()).toHaveLength(1)
      expect(readFileSync).toHaveBeenCalledTimes(1)
    } finally { clock.mockRestore() }
  })

  it('sees saves, patches, external replacements, in-place edits and deletion immediately', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    store.list()
    store.patch(saved.agentId, { cwd: '/changed' })
    expect(store.list()[0].cwd).toBe('/changed')
    store.save({ ...saved, title: 'Updated title' })
    expect(store.list()[0].title).toBe('Updated title')
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const replacement = `${file}.tmp`
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.session.title = 'External edit'
    writeFileSync(replacement, JSON.stringify(raw), { mode: 0o600 })
    renameSync(replacement, file)
    expect(store.list()[0].title).toBe('External edit')
    const before = statSync(file)
    raw.session.title = 'External next' // Same length; restoring mtime must not conceal the edit.
    writeFileSync(file, JSON.stringify(raw))
    utimesSync(file, before.atime, before.mtime)
    expect(store.list()[0].title).toBe('External next')
    rmSync(file)
    expect(store.list()).toEqual([])
    store.save(saved)
    expect(store.list()[0].sessionId).toBe(saved.sessionId)
  })

  it('drops a warmed record when corrupted, unsafe, or replaced by a symlink', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const raw = readFileSync(file, 'utf8')
    store.list()
    writeFileSync(file, '{')
    expect(store.list()).toEqual([])
    writeFileSync(file, raw)
    expect(store.list()).toHaveLength(1)
    chmodSync(file, 0o666)
    expect(store.list()).toEqual([])
    expect(() => store.get(saved.agentId)).toThrow()
    chmodSync(file, 0o600)
    expect(store.list()).toHaveLength(1)
    rmSync(file)
    const target = join(directory, 'other.json')
    writeFileSync(target, raw, { mode: 0o600 })
    symlinkSync(target, file)
    expect(store.list()).toEqual([])
    expect(() => store.get(saved.agentId)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe(raw)
    chmodSync(join(directory, 'stopped-agents'), 0o777)
    expect(() => store.list()).toThrow()
  })

  it('does not cache a read under the identity of a replacement made during that read', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.session.title = 'Replacement'
    const replacement = `${file}.tmp`
    writeFileSync(replacement, JSON.stringify(raw), { mode: 0o600 })
    const real = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(readFileSync).mockImplementationOnce((...args: any[]) => {
      const value = (real.readFileSync as (...args: any[]) => any)(...args)
      renameSync(replacement, file)
      return value
    })
    expect(store.list()[0].title).toBe(saved.title)
    expect(store.list()[0].title).toBe('Replacement')
  })

  it('bounds retained bytes while keeping every large record visible and fresh', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const base = join(directory, 'stopped-agents')
    rmSync(join(base, `${saved.agentId}.json`))
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(base, `large-${i}.json`), JSON.stringify({ version: 1,
        session: { ...saved, agentId: `large-${i}`, title: 'x'.repeat(512 * 1024) } }), { mode: 0o600 })
    }
    expect(store.list()).toHaveLength(10)
    vi.mocked(readFileSync).mockClear()
    expect(store.list()).toHaveLength(10)
    // Ten half-megabyte files exceed the cache's byte budget; some must stay on disk.
    expect(vi.mocked(readFileSync).mock.calls.length).toBeGreaterThan(0)
    expect(vi.mocked(readFileSync).mock.calls.length).toBeLessThan(10)
    for (let i = 0; i < 10; i++) rmSync(join(base, `large-${i}.json`))
    expect(store.list()).toEqual([])
    store.save(saved)
    store.list()
    vi.mocked(readFileSync).mockClear()
    expect(store.list()).toHaveLength(1)
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('bounds cached record count without thrashing or hiding a larger catalog', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const base = join(directory, 'stopped-agents')
    rmSync(join(base, `${saved.agentId}.json`))
    for (let i = 0; i < 2050; i++) {
      const agentId = `bounded-${String(i).padStart(4, '0')}`
      writeFileSync(join(base, `${agentId}.json`), JSON.stringify({ version: 1,
        session: { ...saved, agentId } }), { mode: 0o600 })
    }
    expect(store.list()).toHaveLength(2050)
    for (let pass = 0; pass < 2; pass++) {
      vi.mocked(readFileSync).mockClear()
      expect(store.list()).toHaveLength(2050)
      expect(readFileSync).toHaveBeenCalledTimes(2)
    }
  })
})

async function fixture() {
  const { registry } = await import('./registry.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const entry = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: '/tmp/work', defaultName: 'My work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan' })!
  const saved: RegisteredSession = { ...entry, sessionId: 'conversation-123', title: 'Continue my work', processIdentity: { pid: 98765, executable: 'codex', startMarker: 'old-process' } }
  const store = new StoppedAgentStore(join(directory, 'stopped-agents'))
  return { registry, StoppedAgentStore, saved, store }
}

describe('stopped harness persistence', () => {
  it('retains the conversation and launch profile after removal and store reload', async () => {
    const { registry, StoppedAgentStore, saved, store } = await fixture()
    store.save(saved)
    registry.removeAgent(saved.agentId)
    const restored = new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId)!
    expect(restored).toMatchObject({ agentId: saved.agentId, sessionId: 'conversation-123', engine: 'codex', cwd: '/tmp/work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan', active: false })
    expect(registry.list()).toHaveLength(0)
    expect(registry.advertised()).toHaveLength(0)
    expect(store.available([])).toHaveLength(1)
    expect(statSync(join(directory, 'stopped-agents', `${saved.agentId}.json`)).mode & 0o777).toBe(0o600)
  })

  it('patches one field of an archive without touching its name or activity time', async () => {
    const { saved, store } = await fixture()
    store.save({ ...saved, defaultName: 'harness Desktop' })
    const before = store.get(saved.agentId)!
    expect(store.patch(saved.agentId, { cwd: '/tmp/work-repaired' })).toBe(true)
    const after = store.get(saved.agentId)!
    expect(after).toEqual({ ...before, cwd: '/tmp/work-repaired' })
    expect(after.touchedAt).toBe(before.touchedAt)
    expect(after.defaultName).toBe('harness Desktop')
    expect(store.patch('never-saved', { cwd: '/tmp' })).toBe(false)
  })

  // The global "last used" order must not forget an agent because it was paused: the archive keeps
  // the stamp, the store reads it back, and the resumed row carries it into the live registry.
  it('keeps when an app last opened the agent through a stop and a resume', async () => {
    const { registry, StoppedAgentStore, saved, store } = await fixture()
    const opened = registry.markOpened(saved.agentId)!.lastOpenedAt!
    expect(opened).toBeGreaterThan(0)
    store.save({ ...registry.byAgent(saved.agentId)!, sessionId: saved.sessionId })
    registry.removeAgent(saved.agentId)
    const archived = new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId)!
    expect(archived.lastOpenedAt).toBe(opened)
    const resumed = registry.resumePendingAgent(archived, [{ backend: 'tmux', paneId: '%77' }])!
    expect(resumed.lastOpenedAt).toBe(opened)
    expect(registry.byAgent(saved.agentId)?.lastOpenedAt).toBe(opened)
  })

  it('hides a running identity or conversation, without discarding its archive', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    expect(store.available([saved])).toEqual([])
    expect(store.available([{ ...saved, agentId: 'another-agent' }])).toEqual([])
    expect(store.available([{ ...saved, agentId: 'another-agent', codexHome: '/other/profile' }])).toHaveLength(1)
    expect(store.available([])).toHaveLength(1)
  })

  it('stopping the shell left by an exited engine preserves its conversation', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    store.save({ ...saved, engine: 'terminal', sessionId: '', codexHome: null, dsh: null })
    expect(store.get(saved.agentId)).toMatchObject({ engine: 'codex', sessionId: 'conversation-123', codexHome: '/tmp/profile' })
  })

  it('resumes on a new route with the same identity and refuses a duplicate claim', async () => {
    const { registry, saved, store } = await fixture()
    store.save(saved)
    registry.removeAgent(saved.agentId)
    const resumed = registry.resumePendingAgent(store.get(saved.agentId)!, [{ backend: 'tmux', paneId: '%99' }])!
    expect(resumed).toMatchObject({ agentId: saved.agentId, sessionId: saved.sessionId, tmuxPane: '%99', processIdentity: null, launch: { state: 'starting' }, permissionMode: 'plan', codexHome: '/tmp/profile' })
    expect(registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%100' }])).toBeNull()
    expect(registry.advertised()).toHaveLength(1)
  })

  it('does not follow a planted archive symlink or overwrite unsafe state', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const other = join(directory, 'other.json')
    writeFileSync(other, 'untouched', { mode: 0o600 })
    rmSync(file)
    symlinkSync(other, file)
    expect(() => store.get(saved.agentId)).toThrow()
    expect(() => store.save(saved)).toThrow()
    expect(readFileSync(other, 'utf8')).toBe('untouched')
    rmSync(file)
    store.save(saved)
    chmodSync(file, 0o666)
    expect(() => store.get(saved.agentId)).toThrow()
  })
})


it('keeps the original identity searchable while preserving the surviving shell route', async () => {
  const { registry, saved, store } = await fixture()
  // Use the actual row, as the daemon does after registering its session.
  Object.assign(registry.byAgent(saved.agentId)!, saved)
  store.save(saved)
  const shell = registry.releaseEngine(saved.agentId, true)!
  expect(shell.agentId).not.toBe(saved.agentId)
  expect(shell).toMatchObject({ engine: 'terminal', sessionId: '', tmuxPane: '%8', processIdentity: null })
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(registry.bySession(saved.sessionId)).toBeUndefined()
  expect(store.available(registry.list()).map(row => row.agentId)).toEqual([saved.agentId])
  const resumed = registry.resumePendingAgent(store.get(saved.agentId)!, [{ backend: 'tmux', paneId: '%99' }])!
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
  expect(store.list()).toEqual([])
  store.save(saved)
  const base = join(directory, 'stopped-agents')
  for (const [id, content] of Object.entries({ corrupt: '{', version: JSON.stringify({ version: 99 }), invalid: JSON.stringify({ version: 1, session: {} }), mismatch: JSON.stringify({ version: 1, session: saved }) })) {
    writeFileSync(join(base, `${id}.json`), content, { mode: 0o600 })
  }
  writeFileSync(join(base, 'unrelated.tmp'), 'skip')
  expect(store.list().map(row => row.agentId)).toEqual([saved.agentId])
  expect(store.get('missing')).toBeNull()
  expect(store.get('../invalid')).toBeNull()
  expect(() => store.save({ ...saved, agentId: '../invalid' })).toThrow()
  expect(() => store.beginResume('../invalid')).toThrow()
  store.finishResume('../invalid')
  store.finishResume('absent')
  chmodSync(base, 0o777)
  expect(() => store.list()).toThrow()
})

it('persists a standalone shell and a runtime without the legacy tmux alias', async () => {
  const { saved, store } = await fixture()
  store.save({ ...saved, engine: 'terminal', sessionId: '', tmuxPane: '', runtimes: [{ backend: 'unknown', endpointId: 'fixture', paneId: '1' } as any], primaryRuntimeKey: ['unknown', 'fixture', '1'].join('\0'), codexHome: null })
  const disk = JSON.parse(readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8'))
  expect(disk.session).not.toHaveProperty('tmuxPane')
  expect(disk.session.sessionId).toBe('')
  store.save({ ...saved, agentId: 'null-profile', codexHome: null })
  expect(store.available([{ ...saved, agentId: 'live', codexHome: null }]).some(row => row.agentId === 'null-profile')).toBe(false)
  expect(store.available([{ ...saved, sessionId: '' }])).toBeDefined()
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
  store.save(saved)
  const real = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(openSync).mockImplementation((file, flags, mode) => {
    if (typeof flags === 'number' && (flags & constants.O_EXCL)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return real.openSync(file, flags, mode)
  })
  expect(() => store.beginResume(saved.agentId)).toThrow('disk full')
  expect(store.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
})

it('an unbound observation of the same process keeps its confirmed conversation', async () => {
  const { saved, store } = await fixture()
  saved.transcriptPath = '/history.jsonl'; saved.boundAt = 1; saved.source = 'hook'; store.save(saved)
  store.save({ ...saved, sessionId: '', transcriptPath: null, title: 'Renamed', boundAt: null, source: null })
  expect(store.get(saved.agentId)).toMatchObject({ sessionId: saved.sessionId, transcriptPath: '/history.jsonl', title: 'Renamed', boundAt: 1, source: 'hook' })
})
it.each(['engine', 'missing', 'previous missing', 'pid', 'start', 'executable'])('does not transfer a binding to a different process: %s', async mode => {
  const { saved, store } = await fixture()
  store.save(mode === 'previous missing' ? { ...saved, processIdentity: null } : saved)
  const next = { ...saved, sessionId: '', processIdentity: { ...saved.processIdentity! } } as RegisteredSession
  if (mode === 'engine') next.engine = 'claude'
  if (mode === 'missing') next.processIdentity = null
  if (mode === 'pid') next.processIdentity!.pid++
  if (mode === 'start') next.processIdentity!.startMarker = 'new'
  if (mode === 'executable') next.processIdentity!.executable = 'other'
  store.save(next); expect(store.get(saved.agentId)?.sessionId).toBe('')
})
