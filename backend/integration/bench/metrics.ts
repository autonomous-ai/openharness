/** One call the scenario made, as the client saw it. */
export interface Sample {
  /** The command type or the non-command path, e.g. `message.send`, `observeMachine`, `read.full`. */
  op: string
  /** Who made it, e.g. `agent-03`, `machine-2`, `desktop-0`. */
  writer: string
  ms: number
  /** The error code of every database transaction attempt that failed and was retried or given up. */
  failedAttempts: string[]
  /** `ok`, or the error code the client got (`SWARM_BUSY` when the store gave up retrying). */
  outcome: string
  /** Response body size, for readers. */
  bytes?: number
}

export interface Row {
  key: string
  count: number
  ok: number
  /** Failed transaction attempts (write conflicts and other retryable errors). */
  conflicts: number
  /** Calls that needed at least one retry. */
  retriedCalls: number
  swarmBusy: number
  /** Other error outcomes, by code. */
  errors: Record<string, number>
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
  bytes: { mean: number; p50: number; p95: number; total: number } | null
}

/** Nearest-rank percentile; null when there are no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

function row(key: string, samples: readonly Sample[]): Row {
  const ms = samples.map(s => s.ms)
  const sizes = samples.flatMap(s => s.bytes === undefined ? [] : [s.bytes])
  const errors: Record<string, number> = {}
  for (const s of samples) if (s.outcome !== 'ok' && s.outcome !== 'SWARM_BUSY') errors[s.outcome] = (errors[s.outcome] ?? 0) + 1
  const total = sizes.reduce((sum, n) => sum + n, 0)
  return {
    key, count: samples.length, ok: samples.filter(s => s.outcome === 'ok').length,
    conflicts: samples.reduce((sum, s) => sum + s.failedAttempts.length, 0),
    retriedCalls: samples.filter(s => s.failedAttempts.length > 0).length,
    swarmBusy: samples.filter(s => s.outcome === 'SWARM_BUSY').length, errors,
    p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), maxMs: percentile(ms, 100),
    bytes: sizes.length ? { mean: Math.round(total / sizes.length), p50: percentile(sizes, 50)!, p95: percentile(sizes, 95)!, total } : null,
  }
}

function grouped(samples: readonly Sample[], key: (s: Sample) => string): Row[] {
  const groups = new Map<string, Sample[]>()
  for (const s of samples) {
    const list = groups.get(key(s))
    if (list) list.push(s)
    else groups.set(key(s), [s])
  }
  return [...groups.keys()].sort().map(k => row(k, groups.get(k)!))
}

export class Recorder {
  private readonly samples: Sample[] = []
  add(sample: Sample): void { this.samples.push(sample) }
  byOp(): Row[] { return grouped(this.samples, s => s.op) }
  byWriter(): Row[] { return grouped(this.samples, s => s.writer) }
}
