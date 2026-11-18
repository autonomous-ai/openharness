/** Complete lean source facts for component tests; no fabricated RegisteredSession or AgentView. */
import type { SessionSnapshot, SessionSnapshotRow } from '../core/api.js'

export function snapshotFixture(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { version: 1, registered: [], cloud: [], machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' },
    signedIn: true, environment: 'prod', hasWindow: true, ...over }
}
export function snapshotRow(agentId = 'agent', over: Partial<SessionSnapshotRow> = {}): SessionSnapshotRow {
  return { session: { agentId, sessionId: `s-${agentId}`, engine: 'claude', registeredAt: 1, transcriptPath: null, lastHookAt: 0,
    active: true, cwd: null, dsh: null }, facts: { displayName: 'Agent', terminalAvailable: true, parts: {} },
    selectedModel: null, turnRunning: false, ...over }
}
