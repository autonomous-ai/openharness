/** Fake machines, for a sleeping Buddy's tests (buddySleep.test.ts). */
import type { SuperTabState } from './model.js'

export const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
export const NOW = Date.parse('2026-11-05T20:00:00Z')
export const GB = 1024 ** 3
export type Pool = NonNullable<SuperTabState['machines']>[number]

/** A fresh machine reading: online now, signed in, quota half used resetting in [resetIn], [diskFree] bytes free. */
export function machine(machineId: string, options: { receivedAt?: number; signedIn?: boolean; usedPercent?: number; resetIn?: number; known?: boolean;
  diskFree?: number } = {}): Pool {
  return {
    machineId, name: machineId, cwd: `/swarms/${machineId}`, engines: ['claude'], maxAgents: 8, contributorId: 'owner', membershipGeneration: 'g',
    generation: `${machineId}-g`, paused: false, scope: 'swarm',
    observation: {
      receivedAt: options.receivedAt ?? NOW - 5_000, runningHarnessIds: [], stoppedHarnessIds: [],
      resources: { diskFreeBytes: options.diskFree ?? 200 * GB, diskTotalBytes: 500 * GB, memoryUsedBytes: 0, memoryTotalBytes: 64 * GB },
      readiness: { engines: [{ engine: 'claude', installed: true, signedIn: options.signedIn ?? true }] },
      quotas: [{ engine: 'claude', known: options.known ?? true, windows: [{ name: 'weekly', usedPercent: options.usedPercent ?? 50,
        resetsAt: new Date(NOW + (options.resetIn ?? 3 * 86_400_000)).toISOString() }] }],
    },
  } as unknown as Pool
}
