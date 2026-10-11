/** Real private files exercise finite reads and descriptor ownership, including pathname ABA. */
import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readHandoffFile } from './handoffFiles.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
let root: string, path: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'handoff-file-')))
  path = join(root, 'receipt.json')
  fs.writeFileSync(path, 'A complete retained receipt', { mode: 0o600 })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('completes short reads but rejects a truncated read and closes both descriptors', () => {
  const read = fs.readSync, close = vi.spyOn(fs, 'closeSync')
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    read(fd, buffer, offset, Math.min(length, 3), position)) as typeof fs.readSync)
  expect(readHandoffFile(path, 1024, true).text).toBe('A complete retained receipt')
  expect(close).toHaveBeenCalledTimes(1)
  vi.mocked(fs.readSync).mockReturnValueOnce(0)
  expect(() => readHandoffFile(path, 1024, true)).toThrow()
  expect(close).toHaveBeenCalledTimes(2)
})

it('bounds repeated short reads instead of accepting an unfinished prefix', () => {
  fs.writeFileSync(path, 'x'.repeat(129))
  const read = fs.readSync, close = vi.spyOn(fs, 'closeSync')
  const calls = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    read(fd, buffer, offset, Math.min(length, 1), position)) as typeof fs.readSync)
  expect(() => readHandoffFile(path, 1024, true)).toThrow()
  expect(calls).toHaveBeenCalledTimes(128)
  expect(close).toHaveBeenCalledTimes(1)
})

it('rejects a different opened inode even when the original pathname is restored before fstat', () => {
  const open = fs.openSync, close = vi.spyOn(fs, 'closeSync'), read = vi.spyOn(fs, 'readSync')
  vi.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
    fs.renameSync(path, path + '.retained')
    fs.writeFileSync(path, 'Foreign receipt', { mode: 0o600 })
    const fd = open(...args)
    fs.renameSync(path, path + '.foreign'); fs.renameSync(path + '.retained', path)
    return fd
  })
  expect(() => readHandoffFile(path, 1024, true)).toThrow()
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1)
  expect(fs.readFileSync(path, 'utf8')).toBe('A complete retained receipt')
})

it('opens special files without blocking and refuses them before reading', () => {
  const fifo = join(root, 'fifo')
  execFileSync('mkfifo', [fifo])
  const open = vi.spyOn(fs, 'openSync'), read = vi.spyOn(fs, 'readSync'), close = vi.spyOn(fs, 'closeSync')
  expect(() => readHandoffFile(fifo, 1024)).toThrow()
  expect(open).toHaveBeenCalledWith(fifo, expect.any(Number))
  expect(Number(open.mock.calls[0][1]) & fs.constants.O_NONBLOCK).not.toBe(0)
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1)
})
