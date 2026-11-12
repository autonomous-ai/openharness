/**
 * How many workers the unit suite runs its files in (cli/vitest.config.ts).
 *
 * These suites spawn real shells, hooks and tmux helpers with bounded deadlines. One worker per CPU starves those children on
 * busy hosts, so a run takes half the cores it may use: the other half is theirs.
 *
 * The cores it may use are the machine's, or its agent's share of them: a Swarm starts each of its agents with its share in
 * HARNESS_CORES (superTabs/inCore/launch.ts). Before, every run sized itself to the whole machine whatever else ran there.
 * On 16 threads, four runs at once of an eighth of this suite took 204 to 230 s each against 79 to 115 s alone, and every
 * one failed on deadlines. At half their shares none failed, in 350 to 549 s (docs/research/2026-11-11-agents-share-cpu.md).
 */
import { availableParallelism } from 'node:os'

export function suiteWorkers(env: NodeJS.ProcessEnv = process.env, machine: number = availableParallelism()): number {
  const share = Number(env.HARNESS_CORES)
  // Anything but a count of cores is no share: the run sizes itself to the machine, as outside a Swarm. A share is never
  // more than the machine has: one carried to a smaller machine (a shell or a daemon its agent started) takes that one's.
  const cores = Number.isSafeInteger(share) && share > 0 ? Math.min(share, machine) : machine
  return Math.max(1, Math.floor(cores / 2))
}
