/**
 * How many workers the unit suite runs its files in (cli/vitest.config.ts).
 *
 * These suites spawn real shells, hooks and tmux helpers with bounded deadlines. One worker per CPU starves those children on
 * busy hosts, so a run takes half the machine's cores: the other half is theirs.
 */
import { availableParallelism } from 'node:os'

export function suiteWorkers(machine: number = availableParallelism()): number {
  return Math.max(1, Math.floor(machine / 2))
}
