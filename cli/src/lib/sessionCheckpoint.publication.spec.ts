import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import type { RegisteredSession } from './registry.js'

const disk = vi.hoisted(() => ({ directory: '', point: '' as '' | 'open' | 'sync' | 'before' | 'screen' | 'pending',
  renamed: false, armed: false, manifestRenames: 0, directorySyncs: 0, paths: new Map<number, string>(),
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const fail = () => { disk.armed = false; return Object.assign(new Error('injected checkpoint publication failure'), { code: 'EIO' }) }
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (disk.armed && disk.renamed && disk.point === 'open' && String(args[0]) === disk.directory) throw fail()
      const fd = fs.openSync(...args); disk.paths.set(fd, String(args[0])); return fd
    },
    closeSync: (fd: number) => { try { fs.closeSync(fd) } finally { disk.paths.delete(fd) } },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const name = basename(String(args[1]))
      const selected = disk.armed && (disk.point === 'screen' ? /^[a-f0-9]{64}\.screen\.json$/.test(name) : /^[a-f0-9]{64}\.json$/.test(name))
      if (selected && disk.point === 'before') throw fail()
      fs.renameSync(...args)
      if (/^[a-f0-9]{64}\.json$/.test(name)) disk.manifestRenames++
      if (selected) disk.renamed = true
    },
    fsyncSync: (fd: number) => {
      if (disk.paths.get(fd) === disk.directory) {
        disk.directorySyncs++
        if (disk.armed && (disk.point === 'pending' || (disk.renamed && (disk.point === 'sync' || disk.point === 'screen')))) throw fail()
      }
      fs.fsyncSync(fd)
    },
  }
})
let root: string, directory: string, transcript: string, store: SessionCheckpointStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-publication-'))
  directory = join(root, 'checkpoints'); disk.directory = directory
  disk.point = ''; disk.renamed = false; disk.armed = false; disk.manifestRenames = 0; disk.directorySyncs = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await mkdir(join(root, 'profile', 'sessions'), { recursive: true, mode: 0o700 })
  transcript = join(root, 'profile', 'sessions', 'conversation.jsonl')
  store = new SessionCheckpointStore(directory)
})
afterEach(async () => { vi.restoreAllMocks(); disk.armed = false; await rm(root, { recursive: true, force: true }) })
const history = (body: string) => JSON.stringify({ type: 'session_meta', payload: { id: 'conversation', cwd: root, source: 'cli' } }) + '\n' + body + '\n'
const row = (engine: 'terminal' | 'codex') => ({ agentId: 'publication-fixture', engine, sessionId: 'conversation', cwd: root,
  transcriptPath: engine === 'codex' ? transcript : null, codexHome: engine === 'codex' ? join(root, 'profile') : null,
}) as RegisteredSession
async function manifest() {
  const file = (await readdir(directory)).find(name => /^[a-f0-9]{64}\.json$/.test(name))!
  return JSON.parse(await readFile(join(directory, file), 'utf8')) as { file: string }
}
async function save(engine: 'terminal' | 'codex', body: string, screen = engine === 'terminal') {
  if (engine === 'codex') await writeFile(transcript, history(body), { mode: 0o600 })
  return store.save(row(engine), screen ? { screen: body } : {})
}
function arm(point: typeof disk.point) { disk.point = point; disk.armed = true; disk.renamed = false }

describe.skipIf(process.platform === 'win32')('checkpoint publication failure', () => {
  for (const engine of ['terminal', 'codex'] as const) for (const previous of [false, true]) for (const point of ['open', 'sync'] as const) {
    it(`keeps ${engine} history after manifest parent ${point} fails (${previous ? 'replacement' : 'first'} save)`, async () => {
      let before: { file: string } | undefined
      if (previous) { await save(engine, 'old history'); before = await manifest() }
      arm(point)
      await expect(save(engine, 'new history')).rejects.toMatchObject({ code: 'HISTORY_NOT_SAVED' })
      expect(disk.armed).toBe(false); expect(disk.renamed).toBe(true)
      expect(console.error).toHaveBeenCalledExactlyOnceWith('[checkpoint] MANIFEST_DURABILITY_UNCONFIRMED')
      const current = await manifest()
      expect(current.file).not.toBe(before?.file)
      expect(await readFile(join(directory, current.file), 'utf8')).toContain('new history')
      if (before) expect(await readFile(join(directory, before.file), 'utf8')).toContain('old history')
      expect(store.deletionFiles(row(engine))).toContain(join(directory, current.file))
    })
  }
  it('requires a real directory flush before reusing a checkpoint after unconfirmed publication', async () => {
    arm('sync'); await expect(save('codex', 'same history')).rejects.toMatchObject({ code: 'HISTORY_NOT_SAVED' })
    const published = await manifest(), flushes = disk.directorySyncs
    expect(disk.manifestRenames).toBe(1)
    arm('pending'); await expect(store.save(row('codex'))).rejects.toMatchObject({ code: 'HISTORY_NOT_SAVED' })
    expect(disk.manifestRenames).toBe(1); expect(await manifest()).toEqual(published)
    expect(await readFile(join(directory, published.file), 'utf8')).toContain('same history')
    disk.armed = false; await store.save(row('codex'))
    expect(disk.directorySyncs - flushes).toBe(2)
    expect(disk.manifestRenames).toBe(1); expect(await manifest()).toEqual(published)
  })
  for (const engine of ['terminal', 'codex'] as const) for (const point of ['before', 'screen'] as const) {
    it(`keeps ${engine}'s old manifest and removes the unpublished new history after ${point} failure`, async () => {
      await save(engine, 'old history', true); const before = await manifest()
      arm(point)
      await expect(save(engine, 'new history', true)).rejects.toMatchObject({ code: 'HISTORY_NOT_SAVED' })
      expect(disk.armed).toBe(false); expect(disk.renamed).toBe(point === 'screen')
      expect(console.error).not.toHaveBeenCalled()
      expect(await manifest()).toEqual(before)
      expect(await readFile(join(directory, before.file), 'utf8')).toContain('old history')
      expect((await readdir(directory)).filter(name => name.endsWith('.history'))).toEqual([before.file])
    })
  }
})
