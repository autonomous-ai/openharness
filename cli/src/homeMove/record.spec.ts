import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMoveRecord, writeMoveRecord, type MoveRecord } from './record.js'

const folder = (): string => mkdtempSync(join(tmpdir(), 'move-record-'))
const onDisk = (dir: string): unknown => JSON.parse(readFileSync(join(dir, 'home-move.json'), 'utf8'))

const WAITING: MoveRecord = { version: 1, state: 'waiting', reason: 'old-tmux', entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at: 1_763_400_000_000 }
const MOVED: MoveRecord = { version: 1, state: 'moved', entries: 27, bytesCopied: 0, panes: 2, oldProcesses: 0, at: 1_763_400_060_000 }

describe('the move record', () => {
  it('written when the state or the reason changes, not again', () => {
    const dir = folder(), file = join(dir, 'home-move.json')
    expect(writeMoveRecord(dir, WAITING)).toBe(true)
    utimesSync(file, 1_000, 1_000)
    expect(writeMoveRecord(dir, { ...WAITING, at: WAITING.at + 60_000 })).toBe(false)
    expect(statSync(file).mtimeMs).toBe(1_000_000)
    expect(onDisk(dir)).toEqual(WAITING)
    expect(writeMoveRecord(dir, { ...WAITING, reason: 'pty-host' })).toBe(true)
    expect(onDisk(dir)).toEqual({ ...WAITING, reason: 'pty-host' })
    expect(writeMoveRecord(dir, { ...WAITING, state: 'failed', reason: 'pty-host' })).toBe(true)
    expect(onDisk(dir)).toEqual({ ...WAITING, state: 'failed', reason: 'pty-host' })
  })

  it('a stray ~/.harness is said once', () => {
    const dir = folder()
    expect(writeMoveRecord(dir, MOVED)).toBe(true)
    expect(writeMoveRecord(dir, { ...MOVED, stray: true })).toBe(true)
    expect(writeMoveRecord(dir, { ...MOVED, stray: true, at: MOVED.at + 60_000 })).toBe(false)
    expect(onDisk(dir)).toEqual({ ...MOVED, stray: true })
  })

  it('it holds no path and no name', () => {
    const dir = folder()
    const full: MoveRecord = { version: 1, state: 'failed', reason: 'io', entries: 27, bytesCopied: 4096, panes: 2, oldProcesses: 1, at: 1, failedAt: 2, stray: true }
    writeMoveRecord(dir, { ...full, home: '/h', legacy: '/h/.harness', unknown: ['scratch'] } as MoveRecord)
    expect(onDisk(dir)).toEqual(full)
  })

  it('read from the state root once moved, from ~/.harness before', () => {
    const home = folder(), legacy = join(home, '.harness')
    mkdirSync(legacy)
    expect(readMoveRecord(home, {})).toBeNull()
    writeMoveRecord(legacy, WAITING)
    expect(readMoveRecord(home, {})).toEqual(WAITING)
    mkdirSync(join(home, '.local', 'share', 'harness'), { recursive: true })
    mkdirSync(join(home, '.local', 'state', 'harness'), { recursive: true })
    writeMoveRecord(join(home, '.local', 'state', 'harness'), MOVED)
    expect(readMoveRecord(home, {})).toEqual(MOVED)
    // Custom XDG folders: the record is in the state root they name.
    const disk = folder(), env = { XDG_DATA_HOME: join(disk, 'data'), XDG_STATE_HOME: join(disk, 'state') }
    mkdirSync(join(disk, 'data', 'harness'), { recursive: true })
    mkdirSync(join(disk, 'state', 'harness'), { recursive: true })
    writeMoveRecord(join(disk, 'state', 'harness'), { ...MOVED, panes: 0 })
    expect(readMoveRecord(home, env)).toEqual({ ...MOVED, panes: 0 })
  })

  it('mode 600', () => {
    const dir = folder(), file = join(dir, 'home-move.json')
    writeMoveRecord(dir, WAITING)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // One a person opened up is the account's own again at the next change.
    chmodSync(file, 0o644)
    writeMoveRecord(dir, MOVED)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
