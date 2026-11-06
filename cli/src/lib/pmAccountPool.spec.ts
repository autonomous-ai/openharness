import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendPmMove, MAX_MOVES, readPmMoves, readPmPool, readPmTold, setPmPool, writePmTold, type PmMove } from './pmAccountPool.js'

// vitest.tmpdir.ts gives every run its own ADAPTER_DATA_DIR, never the developer's.
const dir = process.env.ADAPTER_DATA_DIR!
const pool = join(dir, 'pm-account-pool.json'), moves = join(dir, 'pm-account-moves.jsonl')
const move = (at: number, over: Partial<PmMove> = {}): PmMove => ({ at, pm: 'Ana', from: 'a', to: 'b', why: 'low', window: 'weekly', leftPercent: 4, ok: true, ...over })

const told = join(dir, 'pm-account-told.json')
afterEach(() => { rmSync(pool, { force: true }); rmSync(moves, { force: true }); rmSync(told, { force: true }) })

describe('the pool', () => {
  it('reads as empty before anything is ticked', () => expect(readPmPool()).toEqual([]))
  it('round-trips, drops duplicates, and keeps the order', () => {
    setPmPool(['b', 'a', 'b'])
    expect(readPmPool()).toEqual(['b', 'a'])
  })
  it('keeps at most 32', () => {
    setPmPool(Array.from({ length: 40 }, (_, i) => `id${i}`))
    expect(readPmPool()).toHaveLength(32)
    expect(readPmPool()[31]).toBe('id31')
  })
  it('keeps an id nobody lists until it is unticked', () => {
    setPmPool(['gone', 'a'])
    expect(readPmPool()).toContain('gone')
    setPmPool(['a'])
    expect(readPmPool()).toEqual(['a'])
  })
  it('is private to its owner', () => {
    setPmPool(['a'])
    expect(statSync(pool).mode & 0o777).toBe(0o600)
  })
  it.each([['not json'], ['{"a":1}'], ['[1,"a","",null,"a"]']])('reads %s without throwing', (text) => {
    writeFileSync(pool, text, { mode: 0o600 })
    expect(readPmPool()).toEqual(text.startsWith('[') ? ['a'] : [])
  })
})

describe('the moves', () => {
  it('reads as none before any move', () => expect(readPmMoves()).toEqual([]))
  it('lists the newest first and honours the limit', () => {
    for (const at of [1, 2, 3]) appendPmMove(move(at))
    expect(readPmMoves().map(m => m.at)).toEqual([3, 2, 1])
    expect(readPmMoves(2).map(m => m.at)).toEqual([3, 2])
  })
  it('keeps the last 200 lines', () => {
    for (let at = 1; at <= MAX_MOVES + 5; at++) appendPmMove(move(at))
    expect(readFileSync(moves, 'utf8').trim().split('\n')).toHaveLength(MAX_MOVES)
    expect(readPmMoves().at(-1)?.at).toBe(6)
  })
  it('skips a damaged line, and the next move drops it', () => {
    appendPmMove(move(1))
    appendFileSync(moves, 'garbage\n{"at":1}\n')
    appendPmMove(move(2))
    expect(readPmMoves().map(m => m.at)).toEqual([2, 1])
    expect(readFileSync(moves, 'utf8')).not.toContain('garbage')
  })
  it('skips a damaged line when reading', () => {
    writeFileSync(moves, `${JSON.stringify(move(1))}\nnope\n${JSON.stringify(move(2))}\n`, { mode: 0o600 })
    expect(readPmMoves().map(m => m.at)).toEqual([2, 1])
  })
  it('keeps awayMs and the failed flag', () => {
    appendPmMove(move(1, { why: 'fallback', awayMs: 4000, ok: false }))
    expect(readPmMoves()[0]).toMatchObject({ why: 'fallback', awayMs: 4000, ok: false })
  })
})

describe('the told windows', () => {
  it('reads as none before anything is told, and round-trips per PM', () => {
    expect(readPmTold('h1')).toEqual([])
    writePmTold('h1', ['1', '2'])
    writePmTold('h2', ['3'])
    writePmTold('h1', ['1', '2', '4'])
    expect(readPmTold('h1')).toEqual(['1', '2', '4'])
    expect(readPmTold('h2')).toEqual(['3'])
  })
  it('keeps the last 64 keys and the last 64 PMs', () => {
    writePmTold('h1', Array.from({ length: 70 }, (_, i) => String(i)))
    expect(readPmTold('h1')).toHaveLength(64)
    expect(readPmTold('h1')[63]).toBe('69')
    for (let i = 0; i < 70; i++) writePmTold(`pm${i}`, ['x'])
    expect(readPmTold('pm69')).toEqual(['x'])
    expect(readPmTold('h1')).toEqual([])
    expect(readPmTold('pm0')).toEqual([])
  })
  it('a damaged file reads as none, and a non-list entry is dropped', () => {
    writeFileSync(told, '{nope')
    expect(readPmTold('h1')).toEqual([])
    writeFileSync(told, '[1]')
    expect(readPmTold('h1')).toEqual([])
    writeFileSync(told, JSON.stringify({ h1: 'x', h2: ['a', 1] }))
    expect(readPmTold('h1')).toEqual([])
    expect(readPmTold('h2')).toEqual(['a'])
  })
})
