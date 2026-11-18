/** Wi-Fi presentation and Store preparation policy live with their component, outside the session owner. */
import { realpathSync } from 'node:fs'
import type { CoreApi, SessionReadHeader } from '../core/api.js'
import { readSessionView, type SessionProjection } from './sessionSnapshot.js'
import type { AutonomousDeviceAgent } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'

export interface WifiView { agents: AutonomousDeviceAgent[]; store: StoreAgent[]; hasWindow: boolean }
const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}

export function readWifiView(read: CoreApi['agents']['readSessions'], machineId: string, signal?: AbortSignal): Promise<WifiView> {
  return readSessionView(read, header => {
    if (header.machine.id !== machineId) throw new Error('CORE_VIEW_UNAVAILABLE')
    return wifiProjection(header)
  }, signal)
}

export function wifiProjection(header: SessionReadHeader): SessionProjection<WifiView> {
  const agents: AutonomousDeviceAgent[] = [], store: StoreAgent[] = []
  return { row: (member, retain) => {
    if ('gone' in member || member.source !== 'registered') return
    const { session: row, facts, turnRunning } = member.row
    const entry: StoreAgent = { agentId: row.agentId, machineId: header.machine.id,
      packageId: typeof facts.parts.dsh === 'string' ? facts.parts.dsh : row.dsh ?? null,
      engine: row.engine, workspace: canonicalPath(row.cwd), state: row.active ? 'active' : 'inactive',
      runtime: !facts.terminalAvailable || row.launch?.state === 'failed' ? 'unavailable'
        : row.launch?.state === 'starting' ? 'starting' : row.active
          ? (row.launch?.state === 'ready' || row.sessionId || row.engine === 'terminal' ? 'ready' : 'starting') : 'unavailable',
      ...(row.launch?.state === 'failed' ? { error: row.launch.detail ?? row.launch.error } : {}) }
    retain(entry); store.push(entry)
    if (facts.terminalAvailable) {
      const agent: AutonomousDeviceAgent = { agentId: row.agentId, name: facts.displayName, engine: row.engine,
      packageId: entry.packageId, workspace: entry.workspace ?? row.cwd, runtime: entry.runtime, state: turnRunning ? 'running' : 'idle' }
      retain(agent); agents.push(agent)
    }
  }, value: () => ({ agents, store, hasWindow: header.hasWindow }) }
}
