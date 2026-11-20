import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'
import type { ExportOwnership } from '../engines/worker/storageProtocol.js'
type ExposedStage = CheckpointStage & ExportOwnership

const trace = vi.hoisted(() => ({ root: '', opens: 0, next: 0,
  handles: new Map<number, number>(), closed: [] as number[], positions: [] as number[],
  historyCloses: 0, failHistoryClose: false, cap: Infinity, zero: false, failWrite: false, failLink: false, failClose: undefined as number | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (String(args[0]).startsWith(trace.root) && String(args[0]).endsWith('/owner.json')) {
        trace.opens++; trace.handles.set(fd, ++trace.next)
      }
      return fd
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (trace.failLink) { trace.failLink = false; throw Object.assign(new Error('injected link'), { code: 'ENOTSUP' }) }
      return fs.linkSync(...args)
    },
    closeSync: (fd: number) => {
      const opening = trace.handles.get(fd)
      fs.closeSync(fd)
      if (opening !== undefined) {
        trace.handles.delete(fd); trace.closed.push(opening)
        if (trace.failClose === opening) { trace.failClose = undefined; throw new Error('injected uncertain close') }
      }
    },
    writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number, position: number) => {
      if (trace.handles.has(fd)) {
        trace.positions.push(position)
        if (trace.zero) { trace.zero = false; return 0 }
        if (trace.failWrite) { trace.failWrite = false; throw Object.assign(new Error('injected write'), { code: 'ENOSPC' }) }
        length = Math.min(length, trace.cap)
      }
      return fs.writeSync(fd, bytes, offset, length, position)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), close = file.close.bind(file)
    file.close = async () => {
      trace.historyCloses++
      await close()
      if (trace.failHistoryClose) { trace.failHistoryClose = false; throw new Error('injected history close') }
    }
    return file
  } }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
const leases: CheckpointStage[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-owner-handle-')); trace.root = root
  trace.opens = 0; trace.positions.length = 0; trace.closed.length = 0
  trace.historyCloses = 0; trace.failHistoryClose = false; trace.cap = Infinity; trace.zero = false; trace.failWrite = false; trace.failLink = false; trace.failClose = undefined
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  trace.failHistoryClose = false; trace.zero = false; trace.failWrite = false; trace.failLink = false; trace.failClose = undefined
  for (const lease of leases.splice(0)) await lease.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
async function acquire() {
  const lease = await new CheckpointStages(join(root, '.stages')).acquire(target(), process.pid)
  leases.push(lease); return { ...lease, ...lease.handoff() }
}
const record = () => join(root, '.stages', '0', 'owner.json')
const target = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
async function verify(lease: ExposedStage) {
  await writeFile(lease.stage.path, 'history')
  await lease.verify({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
}

it.skipIf(process.platform === 'win32')('keeps one owner handle through all updates and closes it with the lease', async () => {
  const lease = await acquire(), initial = JSON.parse(await readFile(record(), 'utf8'))
  expect(trace.handles.size).toBe(1)
  const [fd, opening] = [...trace.handles][0]
  await lease.settled(); await verify(lease)
  expect(trace.opens).toBe(1); expect(trace.handles.get(fd)).toBe(opening)
  await lease.publish(() => {})
  expect(trace.opens).toBe(1); expect(trace.closed.filter(n => n === opening)).toHaveLength(0)
  expect(fs.fstatSync(fd).isFile()).toBe(true)
  expect(JSON.parse(await readFile(record(), 'utf8'))).toEqual({ ...initial, writer: process.pid,
    settled: true, destination: target().split('/').at(-1) })
  await lease.close(); expect(trace.handles.size).toBe(0)
  expect(trace.closed.filter(n => n === opening)).toHaveLength(1)
  expect(() => fs.fstatSync(fd)).toThrow()
})

it.skipIf(process.platform === 'win32')('writes short chunks from zero and truncates an existing longer journal', async () => {
  const lease = await acquire(), before = JSON.parse(await readFile(record(), 'utf8'))
  await writeFile(record(), JSON.stringify(before) + ' '.repeat(256))
  trace.cap = 7; trace.positions.length = 0
  await lease.settled()
  expect(await readFile(record(), 'utf8')).toBe(JSON.stringify({ ...before, settled: true, destination: target().split('/').at(-1) }))
  expect(trace.positions.length).toBeGreaterThan(1); expect(trace.positions[0]).toBe(0)
  expect(trace.positions.every((position, i) => position === i * 7)).toBe(true)
  expect(trace.opens).toBe(1)
  await lease.close(); expect(trace.handles.size).toBe(0)
})

it.skipIf(process.platform === 'win32')('refuses a zero write without changing the previous complete owner', async () => {
  const lease = await acquire(), before = await readFile(record(), 'utf8')
  trace.zero = true
  await expect(lease.settled()).rejects.toThrow('checkpoint owner write incomplete')
  expect(await readFile(record(), 'utf8')).toBe(before)
  await lease.close(); expect(trace.handles.size).toBe(0)
})

it.skipIf(process.platform === 'win32').each(['zero', 'throw'] as const)('closes its owner handle after an initial %s write failure', async kind => {
  trace.zero = kind === 'zero'; trace.failWrite = kind === 'throw'
  await expect(acquire()).rejects.toThrow()
  expect(trace.opens).toBe(1); expect(trace.handles.size).toBe(0)
  expect(trace.closed).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('keeps the same handle for explicit link retry and a settled update after publication', async () => {
  const lease = await acquire(); await lease.settled(); await verify(lease)
  expect(trace.handles.size).toBe(1)
  const [fd, opening] = [...trace.handles][0]
  trace.failLink = true
  await expect(lease.publish(() => {})).rejects.toMatchObject({ code: 'CHECKPOINT_STAGE_PIN_UNAVAILABLE' })
  expect(trace.handles.get(fd)).toBe(opening); expect(trace.opens).toBe(1)
  await lease.publish(() => {})
  await lease.settled()
  expect(trace.handles.get(fd)).toBe(opening); expect(trace.opens).toBe(1)
  expect(JSON.parse(await readFile(record(), 'utf8')).settled).toBe(true)
  await lease.close(); expect(trace.handles.size).toBe(0)
  expect(trace.closed.filter(n => n === opening)).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('closes the owner even when initial failure cleanup cannot confirm the history close', async () => {
  trace.failWrite = true; trace.failHistoryClose = true
  await expect(acquire()).rejects.toThrow('injected write')
  expect(trace.failWrite).toBe(false); expect(trace.failHistoryClose).toBe(false)
  expect(trace.opens).toBe(1); expect(trace.handles.size).toBe(0)
  expect(trace.closed).toHaveLength(1)
  expect(fs.existsSync(record())).toBe(true)
  expect(console.error).toHaveBeenCalledWith('[checkpoint] STAGE_CLEANUP_UNAVAILABLE')
})

it.skipIf(process.platform === 'win32')('closes the owner once when lease cleanup cannot confirm the history close', async () => {
  const lease = await acquire()
  trace.failHistoryClose = true
  await lease.close(); await lease.close()
  expect(trace.failHistoryClose).toBe(false)
  expect(trace.opens).toBe(1); expect(trace.handles.size).toBe(0)
  expect(trace.closed).toHaveLength(1)
  expect(fs.existsSync(record())).toBe(true)
})

it.skipIf(process.platform === 'win32')('attempts both closes once and latches custody when both report uncertainty', async () => {
  // Give this irreversible failure its own custody module; other cases retain the original module instance.
  vi.resetModules()
  const { CheckpointStages: IsolatedStages } = await import('./checkpointStages.js')
  const manager = new IsolatedStages(join(root, '.stages')), lease = await manager.acquire(target(), process.pid)
  leases.push(lease)
  const opening = [...trace.handles.values()][0]
  trace.failHistoryClose = true; trace.failClose = opening
  await lease.close(); await lease.close()
  expect(trace.failHistoryClose).toBe(false); expect(trace.failClose).toBeUndefined()
  expect(trace.historyCloses).toBe(1)
  expect(trace.closed.filter(n => n === opening)).toHaveLength(1)
  expect(trace.handles.size).toBe(0); expect(fs.existsSync(record())).toBe(true)
  await expect(manager.acquire(target(), process.pid)).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
})

// Last: the process-wide custody latch intentionally cannot be reset after an uncertain close.
it.skipIf(process.platform === 'win32')('does not retry an uncertain retained owner close or remove its slot', async () => {
  const lease = await acquire(); await lease.settled(); await verify(lease)
  expect(trace.handles.size).toBe(1)
  const opening = [...trace.handles.values()][0]
  trace.failClose = opening
  await lease.publish(() => {})
  expect(fs.existsSync(target())).toBe(true)
  await lease.close(); await lease.close()
  await expect(new CheckpointStages(join(root, '.stages')).acquire(target(), process.pid)).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  expect(trace.closed.filter(n => n === opening)).toHaveLength(1)
  expect(fs.existsSync(record())).toBe(true)
})
