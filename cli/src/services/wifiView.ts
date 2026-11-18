/** Wi-Fi presentation and Store preparation policy live with their component, outside the session owner. */
import { realpathSync } from 'node:fs'
import type { SessionReadHeader } from '../core/api.js'
import { readSessionView, type SessionProjection, type SessionRecordObserver, type SessionRecordSource } from './sessionSnapshot.js'
import type { AutonomousDeviceAgent } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'

export interface WifiView { agents: AutonomousDeviceAgent[]; store: StoreAgent[]; hasWindow: boolean }
const canonicalPath = (path: string | null): string | null => {
  if (!path) return null
  try { return realpathSync(path) } catch { return path }
}

export function readWifiView(read: SessionRecordSource, machineId: string, signal?: AbortSignal, observe?: SessionRecordObserver): Promise<WifiView> {
  return readSessionView(read, 'registered', header => {
    if (header.machine.id !== machineId) throw new Error('CORE_VIEW_UNAVAILABLE')
    return wifiProjection(header)
  }, signal, observe)
}

export function wifiProjection(header: SessionReadHeader): SessionProjection<WifiView> {
  const agents: AutonomousDeviceAgent[] = [], store: StoreAgent[] = []
  return { row: (member, budget) => {
    if (member[0] !== 'registered') return
    const [, agentId, sessionId, engine, , , , active, cwd, storedDsh, launch, displayName, terminalAvailable, , turnRunning, publishedDsh] = member
    const [launchState, launchValue, launchDetail] = launch ?? []
    const entry: StoreAgent = { agentId, machineId: header.machine.id,
      packageId: typeof publishedDsh === 'string' ? publishedDsh : storedDsh === false ? null : storedDsh,
      engine, workspace: canonicalPath(cwd), state: active ? 'active' : 'inactive',
      runtime: !terminalAvailable || launchState === 'failed' ? 'unavailable'
        : launchState === 'starting' ? 'starting' : active
          ? (launchState === 'ready' || sessionId || engine === 'terminal' ? 'ready' : 'starting') : 'unavailable',
      ...(launchState === 'failed' ? { error: launchDetail === false ? launchValue : launchDetail } : {}) }
    // These closed primitive projections were built from the checked record; only their exact encoded size is needed.
    budget.retain(Buffer.byteLength(JSON.stringify(entry))); store.push(entry)
    if (terminalAvailable) {
      const agent: AutonomousDeviceAgent = { agentId, name: displayName, engine,
      packageId: entry.packageId, workspace: entry.workspace ?? cwd, runtime: entry.runtime, state: turnRunning ? 'running' : 'idle' }
      budget.retain(Buffer.byteLength(JSON.stringify(agent))); agents.push(agent)
    }
  }, value: () => ({ agents, store, hasWindow: header.hasWindow }) }
}
