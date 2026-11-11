/**
 * The sessions a person took out of a Swarm while they keep running (anh Dee 2026-11-11): taking an agent out of a Swarm
 * takes it off the roster and never stops it, as closing a pane that another tab still shows never does. Its person's apps
 * on every computer read this list and do not offer that session as one to join; adding it by hand does, and clears it.
 *
 * Each person's own, in their member part (Person.removedPanes), which only they read (model.ts visibleState, read/views.ts):
 * a removal writes only that part, and the list leaves with them. What removes a record: adding the session again
 * (commands.ts agent.add), the machine added again (machine.contribute), its host's proof that the session stopped (store.ts,
 * the reservation its removal kept), the person leaving, REMOVED_PANE_KEEP_MS, and the cap, oldest first.
 */
import type { Agent, Person, SuperTabState } from './model.js'

/** The most records one person keeps in a Swarm, as a machine keeps its closed agents' (closedAgents.ts REMOVED_KEPT). */
export const MAX_REMOVED_PANES = 50
/** How long one is kept: as long as a closed agent's record (closedAgents.ts REMOVED_KEEP_MS). */
export const REMOVED_PANE_KEEP_MS = 30 * 24 * 60 * 60_000

export interface RemovedPane { machineId: string; harnessId: string; removedAt: number }

const live = (person: Person, now: number): RemovedPane[] => (person.removedPanes ?? []).filter(r => now - r.removedAt < REMOVED_PANE_KEEP_MS)

function keep(person: Person, panes: RemovedPane[]): void {
  if (panes.length) person.removedPanes = panes
  else delete person.removedPanes
}

/** Records that [target]'s person took it out while its session keeps running. None for a person no longer here. */
export function recordRemovedPane(state: SuperTabState, target: Agent, now: number): void {
  const person = state.people.find(p => p.id === target.contributorId)
  if (!person) return
  keep(person, [...live(person, now).filter(r => r.machineId !== target.machineId || r.harnessId !== target.harnessId),
    { machineId: target.machineId, harnessId: target.harnessId, removedAt: now }].slice(-MAX_REMOVED_PANES))
}

/** Forgets every record of [machineId]'s sessions that [matches]: added again, ended, or their machine added again. */
export function forgetRemovedPanes(state: SuperTabState, machineId: string, matches: (harnessId: string) => boolean): void {
  for (const person of state.people) {
    if (!person.removedPanes?.some(r => r.machineId === machineId && matches(r.harnessId))) continue
    keep(person, person.removedPanes.filter(r => r.machineId !== machineId || !matches(r.harnessId)))
  }
}

/** [person] as [readerId] reads them: their own records unexpired, nobody else's. */
export function removedPanesFor<T extends Person>(person: T, readerId: string | null, now: number): T {
  if (!person.removedPanes) return person
  const { removedPanes: _panes, ...rest } = person
  const own = person.id === readerId ? live(person, now) : []
  return (own.length ? { ...rest, removedPanes: own } : rest) as T
}
