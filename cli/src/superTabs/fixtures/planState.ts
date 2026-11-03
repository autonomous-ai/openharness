/** A Swarm state as the status read gives it, trimmed to what `harness super-tab plan` reads (planInput.spec.ts, planCommand.spec.ts). */
import type { Catalog } from '../route.js'

export const NOW = Date.parse('2026-10-27T01:00:00Z')
/** The routing read of a backend from before the catalog: a policy alone (planCommand.spec.ts reads it as the catalog below). */
export const policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', localModels: { quality: 1, enabled: true }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: false },
] }
/** The same rows as a catalog (route.ts catalogFrom). */
export const catalog: Catalog = { grid: { strength: 1, models: [] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false },
] }
export type Json = Record<string, unknown>

/** A contributed machine as the status read gives it (a real reading, trimmed of fields the plan does not read). */
export function machine(id: string, extra: Json = {}, observation: Json = {}): Json {
  return {
    machineId: id, name: `${id}.local`, cwd: `/Users/x/.harness/cli/data/swarm-projects/tab`, engines: ['claude', 'codex', 'cursor'], maxAgents: 8,
    scope: 'swarm', contributorId: 'owner', paused: false, availableSlots: 2, teamWork: { allowed: true }, ...extra,
    observation: {
      receivedAt: NOW - 5_000, tools: { git: true, node: true, gh: true, python3: true },
      resources: { memoryTotalBytes: 68_719_476_736, memoryUsedBytes: 36_894_949_376, projectDiskFreeBytes: 132_155_797_504, os: 'macOS' },
      quotas: [
        { engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 2, resetsAt: '2026-10-27T03:30:00+00:00' }, { name: 'weekly', usedPercent: 30, resetsAt: '2026-11-01T19:00:00+00:00' }] },
        { engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 40, resetsAt: 1793592000 }] },
      ],
      localModels: [], ...observation,
    },
  }
}
const task = { goal: 'g', changes: 'c', constraints: 'k', owns: ['x/**'] }
export function group(id: string, extra: Json = {}): Json {
  return { id, projectId: 'p1', title: `Group ${id}`, leadId: 'lead1', agentIds: ['lead1'], archived: false, task, assignment: null, ...extra }
}
export function state(extra: Json = {}): Json {
  return {
    id: 'tab', ownerId: 'owner', agents: [], starts: [], rules: [], localModels: { grid: 'swarm-g', enabled: true, ready: true },
    projects: [{ id: 'p1', ownerId: 'owner', repository: { machineId: 'm1', cwd: '/repo', repositoryUrl: 'https://github.com/o/r' } }],
    machines: [machine('m1'), machine('m2')],
    conversations: [{ id: 'lead', leadId: 'lead1', title: 'Lead' }, group('g1'), group('g2')],
    ...extra,
  }
}
