import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const fault = vi.hoisted(() => ({ reused: undefined as { path: string; ino: bigint; dev: bigint } | undefined,
  open: false, write: false, link: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (fault.open && String(args[0]).endsWith('owner.json')) { fault.open = false; throw Object.assign(new Error('injected open'), { code: 'EIO' }) }
      return fs.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.write) { fault.write = false; throw Object.assign(new Error('injected write'), { code: 'ENOSPC' }) }
      return fs.writeFileSync(...args)
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (fault.link) { fault.link = false; throw Object.assign(new Error('injected link'), { code: 'ENOTSUP' }) }
      return fs.linkSync(...args)
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const value = fs.lstatSync(...args)
    if (value && fault.reused?.path === String(args[0])) Object.assign(value, { ino: fault.reused.ino, dev: fault.reused.dev })
    return value
  } }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
const leases: CheckpointStage[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-generation-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  fault.reused = undefined
  fault.open = fault.write = fault.link = false
  vi.restoreAllMocks()
  for (const lease of leases.splice(0)) await lease.close()
  await rm(root, { recursive: true, force: true })
})
const stages = () => new CheckpointStages(join(root, '.stages'))
const target = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
const ownerPath = (lease: CheckpointStage) => join(dirname(lease.stage.path), 'owner.json')
const receipt = () => ({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
async function acquire() { const lease = await stages().acquire(); leases.push(lease); return lease }
async function publish(lease: CheckpointStage) {
  await writeFile(lease.stage.path, 'history'); await lease.verify(receipt()); await lease.publish(target(), () => {})
}
function deadCore() { vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) }) }

it.each(['live close', 'crash recovery'] as const)('preserves a replacement even when its inode number is reused during %s', async cleanup => {
  const lease = await acquire(); await publish(lease)
  const original = await stat(target(), { bigint: true })
  await rm(target()); await writeFile(target(), 'foreign history', { mode: 0o600 })
  fault.reused = { path: target(), ino: original.ino, dev: original.dev }
  if (cleanup === 'live close') await lease.close()
  else { deadCore(); await stages().prepare() }
  expect(await readFile(target(), 'utf8')).toBe('foreign history')
  expect(await stat(ownerPath(lease))).toBeTruthy()
})

it('rereads the owner under the cleanup lock before deleting a newer reservation', async () => {
  const lease = await acquire(), path = ownerPath(lease)
  const old = JSON.parse(await readFile(path, 'utf8'))
  let newer = ''
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (!newer) {
      newer = JSON.stringify({ ...old, core: 424242, lease: 'd'.repeat(32) })
      fs.writeFileSync(path, newer)
    }
    if (pid === 424242) return true
    throw Object.assign(new Error(), { code: 'ESRCH' })
  })
  await stages().prepare()
  expect(await readFile(path, 'utf8')).toBe(newer)
  expect(await stat(lease.stage.path)).toBeTruthy()
  await expect(stat(join(dirname(path), 'cleanup'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('checks core absence again after taking the cleanup lock', async () => {
  const lease = await acquire()
  let checks = 0
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (++checks === 1) throw Object.assign(new Error(), { code: 'ESRCH' })
    return true
  })
  await stages().prepare()
  expect(await stat(ownerPath(lease))).toBeTruthy()
  expect(await stat(lease.stage.path)).toBeTruthy()
})

it('a stale lease cannot overwrite a newer owner that reused the record inode', async () => {
  const lease = await acquire(), path = ownerPath(lease)
  const newer = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), lease: 'e'.repeat(32) })
  await writeFile(path, newer)
  await expect(lease.writer(process.pid)).rejects.toThrow('changed')
  expect(await readFile(path, 'utf8')).toBe(newer)
  await lease.close()
  expect(await readFile(path, 'utf8')).toBe(newer)
})

it('retains a legacy uncommitted destination without a generation pin', async () => {
  const lease = await acquire(); await publish(lease)
  const path = ownerPath(lease), owner = JSON.parse(await readFile(path, 'utf8'))
  delete owner.lease; owner.version = 1
  await writeFile(path, JSON.stringify(owner))
  await rm(lease.stage.path, { force: true })
  deadCore(); await stages().prepare()
  expect(await readFile(target(), 'utf8')).toBe('history')
  expect(await stat(path)).toBeTruthy()
  await expect(stat(join(dirname(path), 'cleanup'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reconsiders a retained generation once its unreadable manifest is repaired', async () => {
  const lease = await acquire(); await publish(lease)
  const manifest = join(root, `${'a'.repeat(64)}.json`)
  await writeFile(manifest, '{unfinished', { mode: 0o600 })
  deadCore(); await stages().prepare()
  await expect(stat(join(dirname(lease.stage.path), 'cleanup'))).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(manifest); await stages().prepare()
  await expect(stat(target())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(ownerPath(lease))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['open', 'write'] as const)('releases its settled writer after a failed owner %s without waiting for core restart', async failure => {
  const lease = await acquire(); await lease.writer(process.pid)
  fault[failure] = true
  await expect(lease.settled()).rejects.toThrow(`injected ${failure}`)
  await lease.close()
  await expect(stat(ownerPath(lease))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await acquire()).stage.path).toBe(lease.stage.path)
})

it.each(['unsupported', 'existing destination'] as const)('names a refused hard link and leaves existing files intact: %s', async reason => {
  const lease = await acquire()
  await writeFile(lease.stage.path, 'history'); await lease.verify(receipt())
  if (reason === 'unsupported') fault.link = true
  else await writeFile(target(), 'foreign history', { mode: 0o600 })
  await expect(lease.publish(target(), () => {})).rejects.toMatchObject({ code: 'CHECKPOINT_STAGE_PIN_UNAVAILABLE' })
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('STAGE_PIN_UNAVAILABLE'))
  if (reason === 'existing destination') expect(await readFile(target(), 'utf8')).toBe('foreign history')
  else await expect(stat(target())).rejects.toMatchObject({ code: 'ENOENT' })
})
