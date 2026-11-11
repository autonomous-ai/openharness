/**
 * The sessions a person took out of a Swarm while they keep running (anh Dee 2026-11-11): taking an agent out of a Swarm
 * takes it off the roster and never stops it, as closing a pane that another tab still shows never does. Its person's apps
 * on every computer read this list and do not add that session back by themselves; adding it by hand does, and clears it.
 *
 * What removes a record: adding the session again (commands.ts agent.add, agent.new), its host's proof that the session
 * stopped (store.ts, the reservation its removal kept), REMOVED_PANE_KEEP_MS, and the cap, oldest first.
 */
import type { Agent, SuperTabState } from './model.js'

/** The most records a Swarm keeps: a Swarm's head holds them, and every read of it sends a reader their own. */
export const MAX_REMOVED_PANES = 100
/** How long one is kept: as long as a closed agent's record (closedAgents.ts REMOVED_KEEP_MS). */
export const REMOVED_PANE_KEEP_MS = 30 * 24 * 60 * 60_000

export interface RemovedPane { machineId: string; harnessId: string; contributorId: string; removedAt: number }

const live = (state: SuperTabState, now: number): RemovedPane[] =>
  (state.removedPanes ?? []).filter(r => now - r.removedAt < REMOVED_PANE_KEEP_MS)

/** Records that [target]'s person took it out while its session keeps running. */
export function recordRemovedPane(state: SuperTabState, target: Agent, now: number): void {
  const kept = live(state, now).filter(r => r.machineId !== target.machineId || r.harnessId !== target.harnessId)
  state.removedPanes = [...kept, { machineId: target.machineId, harnessId: target.harnessId, contributorId: target.contributorId, removedAt: now }]
    .slice(-MAX_REMOVED_PANES)
}

/** Forgets the record of session [harnessId] on [machineId]: added again, or ended. */
export function forgetRemovedPane(state: SuperTabState, machineId: string, harnessId: string): void {
  if (!state.removedPanes?.some(r => r.machineId === machineId && r.harnessId === harnessId)) return
  state.removedPanes = state.removedPanes.filter(r => r.machineId !== machineId || r.harnessId !== harnessId)
  if (!state.removedPanes.length) delete state.removedPanes
}

/** What [personId] reads of the list: their own sessions, unexpired, by machine and session id. */
export const ownRemovedPanes = (state: SuperTabState, personId: string, now: number): Array<{ machineId: string; harnessId: string }> =>
  live(state, now).filter(r => r.contributorId === personId).map(({ machineId, harnessId }) => ({ machineId, harnessId }))
