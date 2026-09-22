/**
 * trigger — decide which engines need a matrix run right now.
 *
 * The rule: run for an engine when its INSTALLED (current) version differs from the tool's LATEST
 * released version. "Current" is read from the installed binary (`--version`/cli_version);
 * "latest" comes from a pluggable `VersionSource` (mock during development, npm when validated).
 *
 * This is the cronjob's decision step, kept pure (no I/O beyond the two injected providers) so it
 * is deterministic and unit-testable offline.
 */
import type { AgentEngine } from '../engines/types.js'
import { type VersionSource } from './versionSource.js'

export interface VersionProvider {
  currentVersion(engine: AgentEngine): Promise<string | null>
}

export interface PlannedRun {
  engine: AgentEngine
  current: string | null
  latest: string | null
  /** Why a run is (or is not) planned — for the audit log + NOTIFY. */
  reason: 'upgrade' | 'downgrade' | 'differs' | 'unknown-current' | 'no-latest' | 'unchanged'
  plan: boolean
}

/** Compare current vs latest for `engines` and return the run plan for each. */
export async function planMatrixRuns(
  source: VersionSource,
  currentProvider: VersionProvider,
  engines: readonly AgentEngine[],
): Promise<PlannedRun[]> {
  const runs: PlannedRun[] = []
  for (const engine of engines) {
    const latest = await source.latestVersion(engine)
    const current = await currentProvider.currentVersion(engine)

    if (latest === null) {
      runs.push({ engine, current, latest, reason: 'no-latest', plan: false })
      continue
    }
    if (current === null) {
      // Installed version unreadable but a latest is known: verify rather than assume.
      runs.push({ engine, current, latest, reason: 'unknown-current', plan: true })
      continue
    }
    const cmp = compareVersions(current, latest)
    runs.push({
      engine,
      current,
      latest,
      reason: cmp === 0 ? 'unchanged' : cmp < 0 ? 'upgrade' : 'downgrade',
      plan: cmp !== 0,
    })
  }
  return runs
}

/**
 * Naive dotted-numeric compare (0.155.0 < 0.155.1, 1.18.31 < 1.18.32). Handles prerelease-ish
 * suffixes by numeric prefix only; good enough to notice "a newer/older stable is out".
 */
export function compareVersions(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number)
  const pb = (b.match(/\d+/g) ?? []).map(Number)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}
