import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

type TimingHints = { defaultDurationMs: number; durationMs: Record<string, number> }

export function readTimingHints(value: unknown): TimingHints {
  const raw = value as { schema?: unknown; defaultDurationMs?: unknown; durationMs?: unknown } | null
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (raw?.schema !== 1 || !positive(raw.defaultDurationMs) || !raw.durationMs
    || typeof raw.durationMs !== 'object' || Array.isArray(raw.durationMs)) {
    throw new Error('Invalid CLI test timing hints')
  }
  for (const [path, duration] of Object.entries(raw.durationMs)) {
    if (!/^src\/.+\.(spec|test)\.ts$/.test(path) || path.includes('\\') || path.split('/').includes('..') || !positive(duration)) {
      throw new Error(`Invalid CLI test timing hint: ${path}`)
    }
  }
  return { defaultDurationMs: raw.defaultDurationMs, durationMs: raw.durationMs as Record<string, number> }
}

const hints = readTimingHints(JSON.parse(readFileSync(new URL('../../ci-test-durations.json', import.meta.url), 'utf8')))

/** Longest estimated files first, each assigned to the least-loaded shard. Timing hints never
 * select tests: the caller's complete discovery list is the only source of entries. New files
 * get a small default cost, and stale hints for removed files cannot add them back to the run. */
export function durationShards<T>(entries: Array<{ key: string; durationMs: number; value: T }>, count: number): T[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer')
  const shards = Array.from({ length: count }, () => ({ cost: 0, values: [] as T[] }))
  const keys = new Set<string>()
  for (const entry of entries) {
    if (keys.has(entry.key) || !Number.isFinite(entry.durationMs) || entry.durationMs <= 0) {
      throw new Error(`Invalid or duplicate shard entry: ${entry.key}`)
    }
    keys.add(entry.key)
  }
  const ordered = [...entries].sort((a, b) => b.durationMs - a.durationMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const entry of ordered) {
    const next = shards.reduce((best, shard) => shard.cost < best.cost
      || (shard.cost === best.cost && shard.values.length < best.values.length) ? shard : best)
    next.cost += entry.durationMs
    next.values.push(entry.value)
  }
  return shards.map(shard => shard.values)
}

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    const entries = files.map(spec => {
      const path = relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
      return { key: `${spec.project.name}\0${spec.pool}\0${path}`,
        durationMs: hints.durationMs[path] ?? hints.defaultDurationMs, value: spec }
    })
    return durationShards(entries, shard.count)[shard.index - 1]
  }
  // Keep Vitest's normal failed-first/cache-aware ordering within each shard, and its
  // project/isolation/group ordering. Unsharded local runs retain the default behavior.
}
