import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'
import { STORAGE_STAGE_BYTES } from '../engines/worker/storageProtocol.js'

let directory: string, root: string
const leases: CheckpointStage[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'checkpoint-stages-')); directory = join(root, '.stages'); await mkdir(directory, { mode: 0o700 }) })
afterEach(async () => { for (const lease of leases.splice(0)) await lease.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const receipt = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })
const target = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
async function acquire(stages = new CheckpointStages(directory), destination = target()) { const lease = await stages.acquire(destination); leases.push(lease); return lease }

it('admits four exact stages, then refuses until a slot has actually been removed', async () => {
  const stages = new CheckpointStages(directory)
  for (let i = 0; i < 4; i++) await acquire(stages)
  await expect(stages.acquire(target())).rejects.toThrow('busy')
  await leases[0].close()
  const next = await acquire(stages)
  expect(next.stage.path).toBe(leases[0].stage.path)
  const previous = leases[0], destination = join(dirname(directory), `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
  const owner = await readFile(join(dirname(next.stage.path), 'owner.json'), 'utf8')
  await expect(previous.writer(process.pid)).rejects.toThrow()
  await expect(previous.settled()).rejects.toThrow()
  await expect(previous.verify(receipt('history'))).rejects.toThrow()
  await expect(previous.publish(() => {})).rejects.toThrow()
  await previous.close()
  expect(await readFile(join(dirname(next.stage.path), 'owner.json'), 'utf8')).toBe(owner)
  await writeFile(next.stage.path, 'history'); await next.settled(); await next.verify(receipt('history'))
  await next.publish(() => {})
  expect(await readFile(destination, 'utf8')).toBe('history')
})

it('checks bytes, hash, inode and private-link identity before accepting output', async () => {
  const lease = await acquire()
  await writeFile(lease.stage.path, 'history')
  await lease.verify(receipt('history'))
  await expect(lease.verify(receipt('another'))).rejects.toThrow('changed')
  await expect(lease.verify({ ...receipt('history'), bytes: STORAGE_STAGE_BYTES + 1 })).rejects.toThrow('invalid')
  await expect(lease.verify(receipt('short'))).rejects.toThrow('size')
  await link(lease.stage.path, join(directory, 'extra'))
  await expect(lease.verify(receipt('history'))).rejects.toThrow('unsafe')
  await rm(join(directory, 'extra'))
})

it('a restarted core retains every unresolved slot while an earlier writer can still hold it', async () => {
  const previous = await acquire()
  await previous.writer(process.pid)
  const worker = await open(previous.stage.path, constants.O_WRONLY)
  try {
    const nextCore = new CheckpointStages(directory)
    await nextCore.prepare()
    const replacement = await acquire(nextCore)
    expect(replacement.stage.path).not.toBe(previous.stage.path)
    await worker.writeFile('late worker output')
    expect((await stat(replacement.stage.path)).size).toBe(0)
    expect(await readFile(previous.stage.path, 'utf8')).toBe('late worker output')
    await previous.close()
    expect(await readFile(replacement.stage.path, 'utf8')).toBe('')
  } finally { await worker.close() }
})

it('startup considers only four fixed names and reserves missing or invalid ownership across repeated restarts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const target = join(directory, 'unrelated'); await writeFile(target, 'keep', { mode: 0o600 })
  await symlink(target, join(directory, '0'))
  await mkdir(join(directory, '1'), { mode: 0o700 })
  await mkdir(join(directory, '2'), { mode: 0o700 })
  await writeFile(join(directory, '2', 'owner.json'), '{}', { mode: 0o600 })
  const last = await acquire()
  expect(last.stage.path).toBe(join(directory, '3', 'history.tmp'))
  await new CheckpointStages(directory).prepare()
  await new CheckpointStages(directory).prepare()
  expect(await readFile(target, 'utf8')).toBe('keep')
  await expect(acquire()).rejects.toThrow('busy')
  await new CheckpointStages(join(directory, 'not-created')).prepare()
})

it('reclaims only after both the old core and its unsettled writer are positively absent', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const lease = await acquire(), record = join(dirname(lease.stage.path), 'owner.json')
  await lease.writer(424242)
  const owner = JSON.parse(await readFile(record, 'utf8'))
  await writeFile(record, JSON.stringify({ ...owner, core: 313131 }))
  const gone = new Set<number>([313131])
  const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (gone.has(pid)) throw Object.assign(new Error(), { code: 'ESRCH' })
    return true
  })
  const next = new CheckpointStages(directory)
  await next.prepare()
  expect((await acquire(next)).stage.path).not.toBe(lease.stage.path)
  kill.mockImplementation(pid => { if (pid === 424242) throw Object.assign(new Error(), { code: 'EPERM' }); throw Object.assign(new Error(), { code: 'ESRCH' }) })
  await next.prepare()
  expect(await stat(lease.stage.path)).toBeTruthy()
  gone.add(424242)
  kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) })
  await next.prepare()
  expect((await acquire(next)).stage.path).toBe(lease.stage.path)
})

it('reclaims a completed worker only after its core is gone, and never repeats an uncertain cleanup', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const completed = await acquire()
  await completed.writer(424242); await completed.settled()
  const next = new CheckpointStages(directory)
  await next.prepare()
  expect((await acquire(next)).stage.path).not.toBe(completed.stage.path)
  vi.spyOn(process, 'kill').mockImplementation(pid => { if (pid === process.pid) throw Object.assign(new Error(), { code: 'ESRCH' }); return true })
  await mkdir(join(dirname(completed.stage.path), 'cleanup'), { mode: 0o700 })
  await next.prepare()
  expect(await stat(completed.stage.path)).toBeTruthy()
  await rm(join(dirname(completed.stage.path), 'cleanup'), { recursive: true })
  await next.prepare()
  expect((await acquire(next)).stage.path).toBe(completed.stage.path)
})

it('two cores share four reservations, and cancellation at the final publication fence leaves no destination', async () => {
  const a = new CheckpointStages(directory), b = new CheckpointStages(directory)
  const values = await Promise.all([acquire(a), acquire(b), acquire(a), acquire(b)])
  expect(new Set(values.map(value => value.stage.path)).size).toBe(4)
  await expect(acquire(b)).rejects.toThrow('busy')
  const lease = values[0], destination = join(dirname(directory), `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
  await writeFile(lease.stage.path, 'history'); await lease.settled(); await lease.verify(receipt('history'))
  await expect(lease.publish(() => { throw new Error('cancelled') })).rejects.toThrow('cancelled')
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['uncommitted', 'committed', 'malformed', 'replaced'] as const)('recovers the exact publication-before-manifest crash window: %s', async state => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const stages = new CheckpointStages(join(directory, '.stages'))
  const name = `${'a'.repeat(64)}-${'b'.repeat(8)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(12)}.history`
  const destination = join(directory, name), manifest = join(directory, `${'a'.repeat(64)}.json`)
  const lease = await acquire(stages, destination)
  await lease.writer(424242)
  await writeFile(lease.stage.path, 'history'); await lease.settled(); await lease.verify(receipt('history'))
  await lease.publish(() => {})
  const pinned = await stat(lease.stage.path, { bigint: true }), published = await stat(destination, { bigint: true })
  expect([pinned.dev, pinned.ino, pinned.nlink]).toEqual([published.dev, published.ino, 2n])
  if (state === 'committed') await writeFile(manifest, JSON.stringify({ version: 1, file: name }), { mode: 0o600 })
  if (state === 'malformed') await writeFile(manifest, '{incomplete', { mode: 0o600 })
  if (state === 'replaced') {
    await rm(destination); await writeFile(destination, 'another history', { mode: 0o600 })
    expect((await stat(destination, { bigint: true })).ino).not.toBe(pinned.ino)
  }
  vi.spyOn(process, 'kill').mockImplementation(pid => { if (pid === process.pid) throw Object.assign(new Error(), { code: 'ESRCH' }); return true })
  const next = new CheckpointStages(join(directory, '.stages'))
  await next.prepare()
  if (state === 'uncommitted') await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(destination, 'utf8')).toBe(state === 'replaced' ? 'another history' : 'history')
  if (state === 'committed') expect((await stat(destination)).nlink).toBe(1)
  const allocated = await acquire(next, destination)
  expect(allocated.stage.path === lease.stage.path).toBe(state === 'uncommitted' || state === 'committed')
})


it('recovers a settled destination before verification or publication without requiring the writer to exit', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const lease = await acquire(), record = join(dirname(lease.stage.path), 'owner.json')
  await lease.writer(424242)
  await writeFile(lease.stage.path, 'history'); await lease.settled()
  expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({ settled: true, destination: basename(target()) })
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === process.pid) throw Object.assign(new Error(), { code: 'ESRCH' })
    return true
  })
  await new CheckpointStages(directory).prepare()
  await expect(stat(lease.stage.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(target())).rejects.toMatchObject({ code: 'ENOENT' })
})
