import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { registry, type RegisteredSession } from './registry.js'
import { sqliteReadAll } from './sqliteRead.js'
import { env } from '../config/env.js'
import { piSessionFolder } from './sessionSearch/externals/pi.js'
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, copyFile: vi.fn(real.copyFile), rm: vi.fn(real.rm) }
})
vi.mock('./sqliteRead.js', () => ({ sqliteReadAll: vi.fn() }))
let root: string
let history: string
let directory: string
let row: RegisteredSession
let store: SessionCheckpointStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-close-checkpoint-'))
  const home = join(root, 'profile')
  await mkdir(join(home, 'sessions'), { recursive: true, mode: 0o700 })
  history = join(home, 'sessions', 'conversation.jsonl')
  await writeFile(history, '{"history":"retained conversation"}\n', { mode: 0o600 })
  row = registry.openPendingAgent({ engine: 'codex', cwd: '/tmp', codexHome: home, runtimes: [{ backend: 'tmux', paneId: '%777' }] })!
  Object.assign(row, { sessionId: 'conversation', transcriptPath: history })
  directory = join(root, 'checkpoints')
  store = new SessionCheckpointStore(directory)
})
afterEach(async () => { vi.restoreAllMocks(); for (const s of registry.list()) registry.removeAgent(s.agentId); await rm(root, { recursive: true, force: true }) })
const manifest = async () => JSON.parse(await readFile(join(directory, (await readdir(directory)).find(f => /^[a-f0-9]{64}\.json$/.test(f))!), 'utf8'))

async function piSession() {
  const previousHome = env.PI_HOME
  env.PI_HOME = join(root, 'pi')
  // This fixture owns every possible source; never scan the developer's Pi store.
  Object.assign(row, { engine: 'pi', sessionId: 'preallocated-session', transcriptPath: null })
  const folder = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder(row.cwd!))
  await mkdir(folder, { recursive: true })
  const path = join(folder, `2026-10-04T12-00-00-000Z_${row.sessionId}.jsonl`)
  return { path, restore: () => { env.PI_HOME = previousHome }, history: `${JSON.stringify({ type: 'session', version: 3, id: row.sessionId, cwd: row.cwd })}\n` }
}

it('checkpoints a Pi startup failure with an ID but no conversation file', async () => {
  const pi = await piSession()
  try {
    await expect(store.save(row)).rejects.toThrow('Could not save this terminal')
    const screen = 'Error: No API key found for the selected model.\nUnsent draft'
    await store.save(row, { screen })
    const saved = await manifest()
    expect(saved.source).toBeNull()
    expect(JSON.parse(await readFile(join(directory, saved.file), 'utf8'))).toMatchObject({
      engine: 'pi', sessionId: row.sessionId, screen,
    })
    await store.save(row, { screen: null }) // post-exit checkpoint
    expect(await manifest()).toEqual(saved)
  } finally { pi.restore() }
})

it.each(['before', 'during'] as const)('backs up a Pi transcript first written %s Close', async when => {
  const pi = await piSession()
  try {
    if (when === 'during') await store.save(row, { screen: 'Waiting for the first reply' })
    await writeFile(pi.path, pi.history)
    await store.save(row)
    const saved = await manifest()
    expect(saved.source).toBe(pi.path)
    expect(await readFile(join(directory, saved.file), 'utf8')).toBe(pi.history)
    expect(row.transcriptPath).toBeNull() // the captured registry row can still be stale
    await rm(pi.path)
    await expect(store.save(row, { screen: 'Still visible' })).rejects.toThrow('conversation file is unavailable')
    expect(await manifest()).toEqual(saved)
  } finally { pi.restore() }
})

it.each(['known', 'resumed', 'unreadable', 'ambiguous', 'unreadable store'] as const)('does not replace %s Pi history with only a screen', async state => {
  const pi = await piSession()
  try {
    if (state === 'known') row.transcriptPath = pi.path
    if (state === 'resumed') row.resumeOnly = true
    if (state === 'unreadable') await writeFile(pi.path, '{partial')
    if (state === 'unreadable store') {
      const folder = join(pi.path, '..')
      await rm(folder, { recursive: true })
      await writeFile(folder, 'not a directory')
    }
    if (state === 'ambiguous') {
      await writeFile(pi.path, pi.history)
      await writeFile(join(pi.path, '..', `other_${row.sessionId}.jsonl`), pi.history)
    }
    await expect(store.save(row, { screen: 'Visible terminal' })).rejects.toThrow()
    expect((await readdir(directory)).filter(file => file.endsWith('.history'))).toEqual([])
  } finally { pi.restore() }
})

it('does not back up a different Pi ID or a project with the same encoded folder', async () => {
  const pi = await piSession()
  try {
    await writeFile(pi.path, `${JSON.stringify({ type: 'session', id: row.sessionId, cwd: '/different/project' })}\n`)
    await store.save(row, { screen: 'Startup screen' })
    expect((await manifest()).source).toBeNull()
    await writeFile(pi.path, `${JSON.stringify({ type: 'session', id: `other_${row.sessionId}`, cwd: row.cwd })}\n`)
    await store.save(row, { screen: 'Startup screen' })
    expect((await manifest()).source).toBeNull()
  } finally { pi.restore() }
})

it('preserves a newly typed draft even when native history has not changed', async () => {
  await store.save(row, { screen: 'first draft' })
  const first = await manifest()
  await store.save(row, { screen: 'new unsent draft' })
  expect(await manifest()).toEqual(first)
  const screen = (await readdir(directory)).find(f => f.endsWith('.screen.json'))!
  expect(JSON.parse(await readFile(join(directory, screen), 'utf8')).screen).toBe('new unsent draft')
  expect((await stat(join(directory, screen))).mode & 0o777).toBe(0o600)
  await store.save(row)
  expect(JSON.parse(await readFile(join(directory, screen), 'utf8')).screen).toBe('new unsent draft')
})

it.each(['terminal', 'claude', 'codex'] as const)('requires a durable screen for unbound %s', async engine => {
  row.engine = engine; row.sessionId = ''; row.transcriptPath = null
  await expect(store.save(row)).rejects.toThrow('Could not save this terminal')
  await store.save(row, { screen: 'unsent work' })
  const before = await manifest()
  await store.save(row)
  expect(await manifest()).toEqual(before)
  expect(JSON.parse(await readFile(join(directory, before.file), 'utf8')).screen).toBe('unsent work')
})

it('retains the full native transcript with private permissions, independently of the original', async () => {
  await store.save(row)
  const saved = await manifest()
  const backup = join(directory, saved.file)
  expect(saved).toMatchObject({ version: 1, agentId: row.agentId, sessionId: row.sessionId, source: history })
  expect(await readFile(backup, 'utf8')).toBe(await readFile(history, 'utf8'))
  expect((await stat(backup)).mode & 0o777).toBe(0o600)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  await rm(history)
  expect(await readFile(backup, 'utf8')).toContain('retained conversation')
})
it('reuses an unchanged checkpoint and replaces it only after a complete new save', async () => {
  await store.save(row)
  const first = await manifest()
  await store.save(row)
  expect(await manifest()).toEqual(first)
  await writeFile(history, '{"history":"last flushed response"}\n')
  await store.save(row)
  const last = await manifest()
  expect(last.file).not.toBe(first.file)
  expect(await readFile(join(directory, last.file), 'utf8')).toContain('last flushed response')
  expect((await readdir(directory)).filter(f => f.endsWith('.history'))).toEqual([last.file])
})
it.each(['missing', 'empty', 'outside profile', 'unbound'])('refuses %s history without destroying an earlier checkpoint', async mode => {
  await store.save(row)
  const saved = await manifest()
  if (mode === 'missing') await rm(history)
  if (mode === 'empty') await writeFile(history, '')
  if (mode === 'outside profile') row.transcriptPath = join(root, 'unrelated')
  if (mode === 'unbound') row.sessionId = ''
  await expect(store.save(row)).rejects.toThrow()
  expect(await manifest()).toEqual(saved)
  expect(await readFile(join(directory, saved.file), 'utf8')).toContain('retained conversation')
})
it('does not hide a corrupt manifest by discarding the last known checkpoint', async () => {
  await store.save(row)
  const saved = await manifest()
  const file = (await readdir(directory)).find(f => f.endsWith('.json'))!
  await writeFile(join(directory, file), '{incomplete')
  await expect(store.save(row)).rejects.toThrow('Could not back up')
  expect(await readFile(join(directory, saved.file), 'utf8')).toContain('retained conversation')
})
it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('exports %s through read-only SQLite, keeping the shared database intact', async engine => {
  row.engine = engine
  row.transcriptPath = null
  const sql = vi.mocked(sqliteReadAll).mockReset().mockResolvedValue({ ok: true, via: 'builtin', rows: [{ id: 'conversation', message: 'Stored in WAL' }] })
  await store.save(row)
  const saved = await manifest()
  expect(await readFile(join(directory, saved.file), 'utf8')).toContain('Stored in WAL')
  for (const [, query, params] of sql.mock.calls) {
    expect(query).toMatch(/^SELECT \* FROM /)
    expect(params).toEqual(['conversation'])
  }
})
it('treats a locked or missing database as a save failure, never an empty successful backup', async () => {
  row.engine = 'hermes'
  vi.mocked(sqliteReadAll).mockResolvedValue({ ok: false, reason: 'transient' })
  await expect(store.save(row)).rejects.toThrow('Could not read')
  expect(await readdir(directory)).toEqual([])
})

it('rebuilds a missing backup and refuses a missing terminal snapshot', async () => {
  await store.save(row)
  await rm(join(directory, (await manifest()).file))
  await store.save(row)
  expect(await readFile(join(directory, (await manifest()).file), 'utf8')).toContain('retained conversation')
  row.engine = 'terminal'; row.sessionId = ''
  await store.save(row, { screen: 'draft' })
  for (const file of await readdir(directory)) if (file.endsWith('.history')) await rm(join(directory, file))
  await expect(store.save(row)).rejects.toThrow('Could not save this terminal')
})
it('refuses an unset conversation path instead of inventing an empty checkpoint', async () => {
  row.transcriptPath = null
  await expect(store.save(row)).rejects.toThrow('conversation file is unavailable')
})
it('rejects a transcript changed during copy and retains the last committed backup', async () => {
  await store.save(row)
  const previous = await manifest()
  await writeFile(history, 'new turn\n')
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(copyFile).mockImplementationOnce(async (source, target, flags) => {
    await real.copyFile(source, target, flags)
    await writeFile(history, 'a response arrived while copying\n')
  })
  await expect(store.save(row)).rejects.toThrow('changed while saving')
  expect(await manifest()).toEqual(previous)
  expect(await readFile(join(directory, previous.file), 'utf8')).toContain('retained conversation')
})
it('rejects a checkpoint that gained an unexpected hard link before commit', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(copyFile).mockImplementationOnce(async (source, target, flags) => {
    await real.copyFile(source, target, flags)
    await link(target, join(root, 'unexpected-link'))
  })
  await expect(store.save(row)).rejects.toThrow('Could not back up')
  expect((await readdir(directory)).some(file => file.endsWith('.json'))).toBe(false)
})
it('keeps a successful new checkpoint when cleanup of the older copy fails', async () => {
  await store.save(row)
  const before = await manifest()
  await writeFile(history, 'new conversation state\n')
  vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
  await store.save(row)
  const after = await manifest()
  expect(after.file).not.toBe(before.file)
  expect(await readFile(join(directory, after.file), 'utf8')).toContain('new conversation state')
})
it('reports the save failure even if cleanup also fails', async () => {
  row.transcriptPath = null
  vi.mocked(rm).mockRejectedValueOnce(new Error('temporary busy')).mockRejectedValueOnce(new Error('destination busy'))
  await expect(store.save(row)).rejects.toThrow('conversation file is unavailable')
})
