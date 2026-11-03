// CI shards of the Super Tab integration suite (backend/vitest.super-tabs.ci.config.ts, task #2459): files are spread over
// the four runners by their recorded durations (backend/integration/ci-durations.json), longest first onto the least-loaded
// shard, as the CLI's vitest.ci.config.ts does (the backend may not import CLI code). Hints never select tests: the
// config's complete discovery list is the only source of files, a new file gets the default cost, and a stale hint for a
// removed file adds nothing.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

export type TimingHints = { defaultDurationMs: number; durationMs: Record<string, number> }

const HINT_PATH = /^integration\/[A-Za-z0-9._/-]+\.test\.ts$/

export function readTimingHints(value: unknown): TimingHints {
  const raw = value as { schema?: unknown; defaultDurationMs?: unknown; durationMs?: unknown } | null
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (raw?.schema !== 1 || !positive(raw.defaultDurationMs) || !raw.durationMs
    || typeof raw.durationMs !== 'object' || Array.isArray(raw.durationMs)) {
    throw new Error('Invalid integration test timing hints')
  }
  for (const [path, duration] of Object.entries(raw.durationMs)) {
    if (!HINT_PATH.test(path) || path.split('/').includes('..') || !positive(duration)) {
      throw new Error(`Invalid integration test timing hint: ${path}`)
    }
  }
  return { defaultDurationMs: raw.defaultDurationMs, durationMs: raw.durationMs as Record<string, number> }
}

export function durationShards<T>(entries: Array<{ key: string; durationMs: number; value: T }>, count: number): T[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be a positive integer')
  const keys = new Set<string>()
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new Error(`Invalid duplicate shard entry: ${entry.key}`)
    if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) throw new Error(`Invalid shard entry: ${entry.key}`)
    keys.add(entry.key)
  }
  const shards = Array.from({ length: count }, () => ({ cost: 0, values: [] as T[] }))
  const ordered = [...entries].sort((a, b) => b.durationMs - a.durationMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const entry of ordered) {
    const next = shards.reduce((best, shard) => shard.cost < best.cost
      || (shard.cost === best.cost && shard.values.length < best.values.length) ? shard : best)
    next.cost += entry.durationMs
    next.values.push(entry.value)
  }
  return shards.map(shard => shard.values)
}

/** A Vitest sequencer that shards by [hints]; unsharded runs keep Vitest's default behavior. */
export function createDurationSequencer(hints: TimingHints): typeof BaseSequencer {
  return class extends BaseSequencer {
    override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      const shard = this.ctx.config.shard
      if (!shard) return files
      const entries = files.map(spec => {
        const path = relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
        return { key: `${spec.project.name}\0${spec.pool}\0${path}`, durationMs: hints.durationMs[path] ?? hints.defaultDurationMs, value: spec }
      })
      return durationShards(entries, shard.count)[shard.index - 1]!
    }
  }
}

export function readTimingHintsFile(path: string): TimingHints {
  return readTimingHints(JSON.parse(readFileSync(path, 'utf8')))
}
