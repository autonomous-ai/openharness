import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { durationShards, readTimingHints } from './ciShards.test-support.js'

const entry = (key: string, durationMs: number) => ({ key, durationMs, value: key })

describe('CI shards of the Super Tab integration suite (task #2459)', () => {
  it('puts every file in exactly one shard, longest first onto the least-loaded shard', () => {
    const files = [entry('a', 100), entry('b', 600), entry('c', 300), entry('d', 300), entry('e', 200), entry('f', 100)]
    const shards = durationShards(files, 4)
    expect(shards).toEqual([['b'], ['c', 'f'], ['d'], ['e', 'a']])
    expect(shards.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('splits evenly enough that no shard holds more than the longest file over its fair share', () => {
    const files = Array.from({ length: 61 }, (_, i) => entry(`f${i}`, ((i * 7919) % 97 + 1) * 1000))
    const shards = durationShards(files, 4)
    const cost = (names: string[]) => names.reduce((sum, name) => sum + files.find(f => f.key === name)!.durationMs, 0)
    const total = cost(files.map(f => f.key))
    for (const shard of shards) expect(cost(shard)).toBeLessThanOrEqual(total / 4 + 97000)
    expect(shards.flat()).toHaveLength(61)
  })

  it('gives more shards than files empty shards, and refuses duplicates or bad counts', () => {
    expect(durationShards([entry('a', 1)], 3)).toEqual([['a'], [], []])
    expect(() => durationShards([entry('a', 1), entry('a', 2)], 2)).toThrow('duplicate')
    expect(() => durationShards([entry('a', 0)], 2)).toThrow('Invalid')
    expect(() => durationShards([entry('a', 1)], 0)).toThrow('positive')
  })

  it('reads hints for integration files only; unknown files are left to the default cost', () => {
    const hints = readTimingHints({ schema: 1, defaultDurationMs: 30000, durationMs: { 'integration/superTabs.test.ts': 400000 } })
    expect(hints.durationMs['integration/superTabs.test.ts']).toBe(400000)
    expect(hints.defaultDurationMs).toBe(30000)
    expect(() => readTimingHints({ schema: 2, defaultDurationMs: 1, durationMs: {} })).toThrow('Invalid')
    expect(() => readTimingHints({ schema: 1, defaultDurationMs: 1, durationMs: { 'src/a.test.ts': 5 } })).toThrow('src/a.test.ts')
    expect(() => readTimingHints({ schema: 1, defaultDurationMs: 1, durationMs: { 'integration/../x.test.ts': 5 } })).toThrow()
    expect(() => readTimingHints({ schema: 1, defaultDurationMs: 1, durationMs: { 'integration/a.test.ts': -1 } })).toThrow()
  })

  // The config lists the files by hand, one a line, and Vitest skips a name that matches no file: a deleted test's line left
  // in, or a new test's line left out, went unseen (#3596 and #3603 left three stale; a test never listed never runs).
  it('lists every integration test file once, and no file that is gone', () => {
    const config = readFileSync(new URL('../../vitest.super-tabs.config.ts', import.meta.url), 'utf8')
    const listed = [...config.matchAll(/'(integration\/[^']+\.test\.ts)'/g)].map(match => match[1]!)
    const present = readdirSync(new URL('../../integration/', import.meta.url)).filter(name => name.endsWith('.test.ts')).map(name => `integration/${name}`)
    expect(listed.filter((file, i) => listed.indexOf(file) !== i)).toEqual([])
    expect([...listed].sort()).toEqual(present.sort())
  })
})
