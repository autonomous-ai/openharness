import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TestSpecification, Vitest } from 'vitest/node'
import { createDurationSequencer, durationShards, DurationSequencer, E2E_HINT_PATH, readTimingHints, readTimingHintsFile } from './__fixtures__/ciTestSequencer.js'

const entries = (costs: number[]) => costs.map((durationMs, value) => ({ key: `file-${value}`, durationMs, value }))

describe('duration-based CLI shards', () => {
  it('spreads long files while preserving every discovered entry once', () => {
    const input = entries([300, 200, 100, 100, 100, 100, 100, 100, 100])
    const shards = durationShards(input, 4)
    expect(shards.flat().sort((a, b) => a - b)).toEqual(input.map(e => e.value))
    expect(shards.map(shard => shard.reduce((total, id) => total + input[id].durationMs, 0))).toEqual([300, 300, 300, 300])
    expect(input.map(e => e.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('assigns the same shards when runners discover equal-cost files in different orders', () => {
    const input = entries([100, 100, 100, 100, 100, 100, 100])
    expect(durationShards([...input].reverse(), 3)).toEqual(durationShards(input, 3))
    expect(durationShards(input, 3).map(shard => shard.length)).toEqual([3, 2, 2])
  })

  it('supports empty discovery, one shard, and more shards than files without dropping entries', () => {
    expect(durationShards([], 4)).toEqual([[], [], [], []])
    expect(durationShards(entries([10, 20]), 4).flat().sort()).toEqual([0, 1])
    expect(durationShards(entries([10, 20]), 1)[0].sort()).toEqual([0, 1])
  })

  it('rejects invalid counts, costs and ambiguous duplicate identifiers', () => {
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(() => durationShards([], count)).toThrow()
    for (const cost of [0, -1, NaN, Infinity]) expect(() => durationShards(entries([cost]), 2)).toThrow()
    expect(() => durationShards([entries([1])[0], entries([2])[0]], 2)).toThrow('duplicate')
  })

  it('rejects malformed timing data instead of silently applying a different schedule', () => {
    const valid = { schema: 1, defaultDurationMs: 100, durationMs: { 'src/slow.spec.ts': 1000 } }
    expect(readTimingHints(valid)).toEqual({ defaultDurationMs: 100, durationMs: valid.durationMs })
    for (const value of [null, {}, { ...valid, schema: 2 }, { ...valid, defaultDurationMs: 0 },
      { ...valid, durationMs: [] }, { ...valid, durationMs: { 'src/slow.spec.ts': NaN } },
      { ...valid, durationMs: { '/other/slow.spec.ts': 10 } }, { ...valid, durationMs: { 'src/../slow.spec.ts': 10 } }]) {
      expect(() => readTimingHints(value)).toThrow('timing hint')
    }
  })

  it('uses relative paths across worktrees and includes new files independently of stale hints', async () => {
    const paths = ['src/devicesCommand.spec.ts', 'src/authCommand.spec.ts', 'src/new.spec.ts', 'src/new2.spec.ts']
    const collect = async (root: string, reverse = false) => {
      const files = paths.map(path => ({ moduleId: resolve(root, path), project: { name: 'cli' }, pool: 'forks' }) as TestSpecification)
      if (reverse) files.reverse()
      return Promise.all([1, 2, 3, 4].map(index => new DurationSequencer({
        config: { root, shard: { index, count: 4 } },
      } as Vitest).shard(files).then(shard => shard.map(spec => paths.find(path => resolve(root, path) === spec.moduleId)!))))
    }
    const first = await collect(resolve('worktree-one'))
    expect(await collect(resolve('worktree-two'), true)).toEqual(first)
    expect(first.flat().sort()).toEqual([...paths].sort())
    expect(first.filter(shard => shard.includes(paths[0]) || shard.includes(paths[1]))).toHaveLength(2)
  })

  it('preserves separate project/pool specifications for the same file', async () => {
    const root = resolve('worktree')
    const files = [['first', 'forks'], ['second', 'forks'], ['second', 'typescript']].map(([name, pool]) => ({
      moduleId: resolve(root, 'src/new.spec.ts'), project: { name }, pool,
    }) as TestSpecification)
    const shards = await Promise.all([1, 2].map(index => new DurationSequencer({
      config: { root, shard: { index, count: 2 } },
    } as Vitest).shard(files)))
    expect(new Set(shards.flat())).toEqual(new Set(files))
    expect(shards.flat()).toHaveLength(files.length)
  })

  it('reads the end-to-end hints with their own file pattern, and neither suite accepts the other\'s files', () => {
    const e2e = { schema: 1, defaultDurationMs: 60_000, durationMs: { 'e2e/races.e2e.ts': 264_300 } }
    expect(readTimingHints(e2e, E2E_HINT_PATH)).toEqual({ defaultDurationMs: 60_000, durationMs: e2e.durationMs })
    expect(() => readTimingHints(e2e)).toThrow('timing hint: e2e/races.e2e.ts')
    expect(() => readTimingHints({ ...e2e, durationMs: { 'src/slow.spec.ts': 10 } }, E2E_HINT_PATH)).toThrow('timing hint')
    expect(() => readTimingHints({ ...e2e, durationMs: { 'e2e/../races.e2e.ts': 10 } }, E2E_HINT_PATH)).toThrow('timing hint')
    // The checked-in hints parse: a malformed file would fail every CI shard before a test ran.
    expect(readTimingHintsFile('ci-e2e-durations.json', E2E_HINT_PATH).defaultDurationMs).toBeGreaterThan(0)
  })

  it('splits end-to-end files by their hints, so the longest files land on different shards', async () => {
    const root = resolve('worktree')
    const hints = { defaultDurationMs: 60_000, durationMs: { 'e2e/a.e2e.ts': 400_000, 'e2e/b.e2e.ts': 300_000, 'e2e/c.e2e.ts': 250_000 } }
    const paths = ['e2e/a.e2e.ts', 'e2e/b.e2e.ts', 'e2e/c.e2e.ts', 'e2e/d.e2e.ts', 'e2e/e.e2e.ts', 'e2e/f.e2e.ts']
    const files = paths.map(path => ({ moduleId: resolve(root, path), project: { name: '' }, pool: 'forks' }) as TestSpecification)
    const Sequencer = createDurationSequencer(hints)
    const shards = await Promise.all([1, 2, 3].map(index => new Sequencer({
      config: { root, shard: { index, count: 3 } },
    } as Vitest).shard(files).then(shard => shard.map(spec => paths.find(path => resolve(root, path) === spec.moduleId)!))))
    expect(shards.flat().sort()).toEqual(paths)
    expect(shards.map(shard => shard.filter(path => path in hints.durationMs))).toEqual([['e2e/a.e2e.ts'], ['e2e/b.e2e.ts'], ['e2e/c.e2e.ts']])
  })
})
