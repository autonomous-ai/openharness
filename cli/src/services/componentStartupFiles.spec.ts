import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { createStartupFiles } from './componentStartupFiles.js'

let dir: string
let log: Mock<(line: string) => void>
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'component-startup-')); log = vi.fn() })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const failure = () => { throw Object.assign(new Error('private path must not be logged'), { code: 'EACCES' }) }

it('observes real saved arrays and file names, without loading an absent component', () => {
  const files = createStartupFiles(log)
  fs.writeFileSync(join(dir, 'task.json'), '[{"id":1}]')
  expect(files.exists(dir)).toBe(true); expect(files.exists(join(dir, 'absent'))).toBe(false)
  expect(files.matches(dir, 'task', '.json')).toBe(true)
  expect(files.matches(dir, 'other', '.json')).toBe(false)
  expect(files.rows(join(dir, 'task.json'))).toEqual([{ id: 1 }])
  expect(files.rows(join(dir, 'absent'))).toEqual([])
  expect(files.matches(join(dir, 'absent'), '', '')).toBe(false)
  expect(files.exists(join(dir, 'task.json', 'child'))).toBe(false)
  expect(log).not.toHaveBeenCalled()
})

it.each([['{}', undefined], ['broken', 'STARTUP_STATE_INVALID'], [' '.repeat(1024 * 1024 + 1), 'STARTUP_STATE_TOO_LARGE']])('bounds and validates saved state', (body, error) => {
  fs.writeFileSync(join(dir, 'state'), body)
  expect(createStartupFiles(log).rows(join(dir, 'state'))).toEqual([])
  if (error) expect(log).toHaveBeenCalledWith(`[startup] ${error}`)
  else expect(log).not.toHaveBeenCalled()
})

it('rejects nonregular state and always closes its descriptor', () => {
  const closeSync = vi.fn(fs.closeSync)
  expect(createStartupFiles(log, { ...fs, closeSync }).rows(dir)).toEqual([])
  expect(log).toHaveBeenCalledWith('[startup] STARTUP_STATE_UNAVAILABLE')
  expect(closeSync).toHaveBeenCalledOnce()
})

it('caps directory work and conservatively starts the component at the cap', () => {
  const readSync = vi.fn(() => ({ name: 'unrelated' }))
  const closeSync = vi.fn()
  const io = { ...fs, opendirSync: () => ({ readSync, closeSync }) as unknown as fs.Dir }
  expect(createStartupFiles(log, io).matches(dir, 'saved', '.json')).toBe(true)
  expect(readSync).toHaveBeenCalledTimes(4096); expect(closeSync).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith('[startup] STARTUP_SCAN_LIMIT')
})

it('bounds short reads and closes after the refusal', () => {
  fs.writeFileSync(join(dir, 'state'), '[]')
  const closeSync = vi.fn(fs.closeSync)
  const readSync = vi.fn(() => 1) as unknown as typeof fs.readSync
  expect(createStartupFiles(log, { ...fs, readSync, closeSync }).rows(join(dir, 'state'))).toEqual([])
  expect(readSync).toHaveBeenCalledTimes(32); expect(closeSync).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith('[startup] STARTUP_STATE_READ_LIMIT')
})

it('names filesystem failures without exposing saved paths or error content', () => {
  const files = createStartupFiles(log, { ...fs, statSync: failure, opendirSync: failure, openSync: failure })
  expect(files.exists(dir)).toBe(false); expect(files.matches(dir, '', '')).toBe(false); expect(files.rows(dir)).toEqual([])
  expect(log.mock.calls).toEqual(Array.from({ length: 3 }, () => ['[startup] STARTUP_STATE_UNAVAILABLE']))
  expect(createStartupFiles(log, { ...fs, statSync: () => { throw new Error('private') } }).exists(dir)).toBe(false)
  expect(log).toHaveBeenLastCalledWith('[startup] STARTUP_STATE_UNAVAILABLE')
})

it('reports scan and descriptor-close failures even after successful reads', () => {
  const directoryClose = vi.fn(failure)
  const io = { ...fs, opendirSync: () => ({ readSync: failure, closeSync: directoryClose }) as unknown as fs.Dir }
  expect(createStartupFiles(log, io).matches(dir, '', '')).toBe(false)
  expect(directoryClose).toHaveBeenCalledOnce()
  fs.writeFileSync(join(dir, 'state'), '[]')
  expect(createStartupFiles(log, { ...fs, closeSync: fd => { fs.closeSync(fd); failure() } }).rows(join(dir, 'state'))).toEqual([])
  expect(log).toHaveBeenCalledTimes(3)
})
