import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestStore, type QueuedRequest } from './requestStore.js'

// Pass-through, noting each open, write and rename by path, until a test fills the disk: a write then stops part way,
// as ENOSPC leaves it.
const disk = vi.hoisted(() => ({ full: false, touched: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.touched.push(`open ${String(args[0])}`); return actual.openSync(...args) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      disk.touched.push(`write ${String(args[0])}`)
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.touched.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})

let dir: string, path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'request-store-')); path = join(dir, 'nested', 'shared-tabs-requests.json') })
afterEach(() => { disk.full = false; disk.touched = []; rmSync(dir, { recursive: true, force: true }) })

const request = (op: 'add' | 'remove' = 'add'): QueuedRequest => ({ sharedTabId: 'a'.repeat(24), op, since: 5,
  harness: { accountId: 'u-bob', machineId: 'm1', machinePublicKey: 'k', agentId: 'api', name: 'api', engine: 'claude' } })

describe('RequestStore', () => {
  it('loads nothing from a missing file', () => {
    expect(new RequestStore(path).load()).toEqual([])
  })

  it('round-trips what it saved, in a file only its owner can read, leaving no temporary file', () => {
    const store = new RequestStore(path), list = [request('add'), request('remove')]
    store.save(list)
    expect(new RequestStore(path).load()).toEqual(list)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['shared-tabs-requests.json'])
  })

  it('the save goes through a temporary file renamed onto the target', () => {
    const store = new RequestStore(path)
    store.save([])
    disk.touched = []
    store.save([request()])
    expect(disk.touched.filter((t) => t.endsWith(` ${path}`))).toEqual([`rename ${path}`])
  })

  it('a save that fails part way leaves the old file, and no temporary file', () => {
    const store = new RequestStore(path)
    store.save([request('add')])
    disk.full = true
    expect(() => store.save([request('remove')])).toThrow(/ENOSPC/)
    disk.full = false
    expect(store.load()).toEqual([request('add')])
    expect(readdirSync(join(dir, 'nested'))).toEqual(['shared-tabs-requests.json'])
  })

  it.each([['not JSON', '{nope'], ['not a list', '{}'], ['a bad entry', JSON.stringify([{ ...request(), sharedTabId: 'x' }])],
    ['an unknown field', JSON.stringify([{ ...request(), extra: 1 }])]])('moves a file that is %s aside and starts empty', (_why, text) => {
    new RequestStore(path).save([])
    writeFileSync(path, text)
    expect(new RequestStore(path, () => 99).load()).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['shared-tabs-requests.json.unreadable-99'])
  })

  it('names the moved file by the clock when it is given none', () => {
    new RequestStore(path).save([])
    writeFileSync(path, '{nope')
    expect(new RequestStore(path).load()).toEqual([])
    expect(readdirSync(join(dir, 'nested'))[0]).toMatch(/^shared-tabs-requests\.json\.unreadable-\d+$/)
  })

  it('still starts empty when the unreadable file cannot be moved', () => {
    new RequestStore(path).save([])
    writeFileSync(path, '{nope')
    // A folder with something in it, under the new name, makes the rename fail.
    mkdirSync(join(`${path}.unreadable-1`, 'x'), { recursive: true })
    expect(new RequestStore(path, () => 1).load()).toEqual([])
  })

  it('throws, and moves nothing aside, when the file cannot be read at all: it may hold requests still waiting', () => {
    // A folder where the file should be: reading it fails as EACCES, EMFILE or EIO would, never as bad contents.
    mkdirSync(path, { recursive: true })
    expect(() => new RequestStore(path).load()).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(readdirSync(join(dir, 'nested'))).toEqual(['shared-tabs-requests.json'])
  })
})
