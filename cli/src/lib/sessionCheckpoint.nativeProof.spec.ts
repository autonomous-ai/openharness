import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

const source = vi.hoisted(() => ({
  path: '', reads: 0, opened: 0, closed: 0,
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  afterOpen: undefined as (() => Promise<void>) | undefined,
  afterPreviousStat: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  afterClose: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const result = await fs.lstat(...args)
    if (String(args[0]).endsWith('.history')) await source.afterPreviousStat?.()
    return result
  }, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) !== source.path) return fs.open(...args)
    await source.beforeOpen?.()
    const handle = await fs.open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle)
    source.opened++
    handle.read = (async (...values: Parameters<typeof read>) => {
      source.reads++; const result = await read(...values)
      const changed = source.afterRead; source.afterRead = undefined; await changed?.(); return result
    }) as typeof handle.read
    handle.close = async () => { await close(); source.closed++; await source.afterClose?.() }
    await source.afterOpen?.()
    return handle
  } }
})
let root: string, directory: string, row: RegisteredSession, store: import('./sessionCheckpoint.js').SessionCheckpointStore
const transcript = (id: string, body: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/tmp', source: 'cli' } }) + '\n' + body + '\n'
beforeEach(async () => {
  vi.resetModules()
  Object.assign(source, { path: '', reads: 0, opened: 0, closed: 0,
    beforeOpen: undefined, afterOpen: undefined, afterPreviousStat: undefined, afterRead: undefined, afterClose: undefined })
  root = await mkdtemp(join(tmpdir(), 'checkpoint-native-proof-')); directory = join(root, 'checkpoints')
  const profile = join(root, 'profile'); await mkdir(join(profile, 'sessions'), { recursive: true, mode: 0o700 })
  source.path = join(profile, 'sessions', 'conversation.jsonl')
  await writeFile(source.path, transcript('conversation', 'retained history'), { mode: 0o600 })
  row = { agentId: 'fixture', engine: 'codex', sessionId: 'conversation', cwd: '/tmp', codexHome: profile, transcriptPath: source.path } as RegisteredSession
  store = new (await import('./sessionCheckpoint.js')).SessionCheckpointStore(directory)
  await store.save(row, { screen: 'retained draft' })
  source.reads = 0
})
afterEach(async () => {
  expect(source.opened).toBe(source.closed)
  await rm(root, { recursive: true, force: true })
})
async function manifest() {
  const name = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!
  return { name, bytes: await readFile(join(directory, name), 'utf8') }
}
async function unchanged(before: Awaited<ReturnType<typeof manifest>>) {
  expect(await manifest()).toEqual(before)
  const saved = JSON.parse(before.bytes)
  expect(await readFile(join(directory, saved.file), 'utf8')).toContain('retained history')
  expect((await readdir(directory)).filter(name => name.endsWith('.history'))).toEqual([saved.file])
  expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false)
  const screen = (await readdir(directory)).find(name => name.endsWith('.screen.json'))!
  expect(JSON.parse(await readFile(join(directory, screen), 'utf8')).screen).toBe('retained draft')
}

it('refuses a different opened descriptor even when the original pathname is restored before stat', async () => {
  const before = await manifest(), original = source.path + '.held', different = source.path + '.different'
  source.beforeOpen = async () => { await rename(source.path, original); await writeFile(source.path, transcript('conversation', 'wrong file'), { mode: 0o600 }) }
  source.afterOpen = async () => { await rename(source.path, different); await rename(original, source.path) }
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(source.reads).toBe(0); await unchanged(before)
})

it('refuses a changed native header between the first and second stat without copying bytes', async () => {
  const before = await manifest()
  source.afterPreviousStat = async () => { await writeFile(source.path, transcript('another-conversation', 'wrong header'), { mode: 0o600 }) }
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(source.reads).toBe(0); await unchanged(before)
})

it('accepts a legitimate new turn before the final pre-copy stat and saves its exact bytes', async () => {
  const bytes = transcript('conversation', 'new turn before copy')
  source.afterPreviousStat = async () => { await writeFile(source.path, bytes, { mode: 0o600 }) }
  await store.save(row)
  expect(await readFile(join(directory, JSON.parse((await manifest()).bytes).file), 'utf8')).toBe(bytes)
})

it.each(['in-place', 'in-place-same-size', 'pathname'])('refuses %s replacement during the descriptor copy and keeps the old checkpoint', async change => {
  const before = await manifest()
  await writeFile(source.path, transcript('conversation', 'fresh history '.repeat(2000)), { mode: 0o600 })
  source.afterRead = async () => {
    if (change === 'pathname') await rename(source.path, source.path + '.held')
    const replaced = change === 'in-place-same-size' ? transcript('replacementx', 'fresh history '.repeat(2000))
      : transcript('another-conversation', 'replaced during copy')
    await writeFile(source.path, replaced, { mode: 0o600 })
  }
  await expect(store.save(row)).rejects.toBeDefined()
  expect(source.reads).toBeGreaterThan(0); await unchanged(before)
})

it.each(['copy', 'reuse'])('rechecks native authority after the input closes on the %s path', async mode => {
  const before = await manifest()
  if (mode === 'copy') await writeFile(source.path, transcript('conversation', 'fresh history'), { mode: 0o600 })
  source.afterClose = async () => { await writeFile(source.path, transcript('another-conversation', 'changed after close'), { mode: 0o600 }) }
  await expect(store.save(row, { screen: 'replacement draft' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(source.reads > 0).toBe(mode === 'copy'); await unchanged(before)
})

it('refuses a headerless native source truncated during the previous-checkpoint metadata read', async () => {
  const { env } = await import('../config/env.js')
  const previousRoot = env.GROK_HOME
  env.GROK_HOME = join(root, 'profile')
  const native = { ...row, engine: 'grok' } as RegisteredSession
  const nativeDirectory = join(root, 'grok-checkpoints')
  const nativeStore = new (await import('./sessionCheckpoint.js')).SessionCheckpointStore(nativeDirectory)
  try {
    await nativeStore.save(native)
    const [name] = (await readdir(nativeDirectory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    const before = await readFile(join(nativeDirectory, name!), 'utf8')
    source.reads = 0
    source.afterPreviousStat = async () => { await writeFile(source.path, '', { mode: 0o600 }) }
    const failure = await nativeStore.save(native).then(() => null, error => error)
    const after = await readFile(join(nativeDirectory, name!), 'utf8')
    const kept = await readFile(join(nativeDirectory, JSON.parse(before).file), 'utf8').then(bytes => bytes.includes('retained history'), () => false)
    expect({ code: failure?.code ?? null, bytes: JSON.parse(after).bytes, unchanged: after === before, kept }).toEqual({
      code: 'HISTORY_NOT_SAVED', bytes: JSON.parse(before).bytes, unchanged: true, kept: true,
    })
    expect(source.reads).toBe(0)
  } finally { env.GROK_HOME = previousRoot }
})

it('accepts a source that becomes nonempty before its final pre-copy stat', async () => {
  const bytes = transcript('conversation', 'complete new turn')
  source.beforeOpen = async () => { await writeFile(source.path, '', { mode: 0o600 }) }
  source.afterPreviousStat = async () => { await writeFile(source.path, bytes, { mode: 0o600 }) }
  await store.save(row)
  expect(await readFile(join(directory, JSON.parse((await manifest()).bytes).file), 'utf8')).toBe(bytes)
})
