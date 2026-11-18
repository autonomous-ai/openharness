/** Wi-Fi presentation and Store preparation policy live with their component, outside the session owner. */
import { realpathSync } from 'node:fs'
import type { SessionSnapshot } from '../core/api.js'
import type { AutonomousDeviceAgent } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'

export interface WifiView { agents: AutonomousDeviceAgent[]; store: StoreAgent[]; hasWindow: boolean }
const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}

export function wifiView(snapshot: SessionSnapshot): WifiView {
  const agents: AutonomousDeviceAgent[] = [], store: StoreAgent[] = []
  for (const { session: row, facts, turnRunning } of snapshot.registered) {
    const entry: StoreAgent = { agentId: row.agentId, machineId: snapshot.machine.id,
      packageId: typeof facts.parts.dsh === 'string' ? facts.parts.dsh : row.dsh ?? null,
      engine: row.engine, workspace: canonicalPath(row.cwd), state: row.active ? 'active' : 'inactive',
      runtime: !facts.terminalAvailable || row.launch?.state === 'failed' ? 'unavailable'
        : row.launch?.state === 'starting' ? 'starting' : row.active
          ? (row.launch?.state === 'ready' || row.sessionId || row.engine === 'terminal' ? 'ready' : 'starting') : 'unavailable',
      ...(row.launch?.state === 'failed' ? { error: row.launch.detail ?? row.launch.error } : {}) }
    store.push(entry)
    if (facts.terminalAvailable) agents.push({ agentId: row.agentId, name: facts.displayName, engine: row.engine,
      packageId: entry.packageId, workspace: entry.workspace ?? row.cwd, runtime: entry.runtime, state: turnRunning ? 'running' : 'idle' })
  }
  return { agents, store, hasWindow: snapshot.hasWindow }
}
