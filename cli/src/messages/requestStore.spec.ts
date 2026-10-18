import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RequestStore, type QueuedRequest } from './requestStore.js'

let dir: string, path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'request-store-')); path = join(dir, 'nested', 'shared-tabs-requests.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

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
