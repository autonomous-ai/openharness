/**
 * Swarm state by parts (docs/design/2026-10-26-swarm-state-parts.md, section 7.2): the interface the store, the read API
 * and the migration share.
 */
import type { Prisma } from '@prisma/client'
import type { SuperTabState } from '../model.js'
import type { GroupData, Part, PartKind, SwarmParts } from './types.js'

export * from './types.js'
type Transaction = Prisma.TransactionClient

const pending = (name: string): never => { throw new Error(`parts.${name} is not implemented yet`) }

/** The parts a command or read needs: everything except dormant groups and finished starts, plus the groups named by id,
 *  the groups the named agents are in (dormant ones too), and the finished starts named by id or agent. */
export function loadActive(_tx: Transaction, _tabId: string,
  _opts?: { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[] }): Promise<SwarmParts> {
  return pending('loadActive')
}
/** Every part of one Swarm: dormant groups, finished starts, and tombstones with their last data (migration, rollback). */
export function loadAll(_tx: Transaction, _tabId: string): Promise<SwarmParts> { return pending('loadAll') }
/** Inserts a Swarm's parts as they are (the migration); a part that already exists fails with P2002. */
export function insertParts(_tx: Transaction, _parts: SwarmParts): Promise<void> { return pending('insertParts') }
/** Parts of these Swarms whose data changed after `since`, by tab. Tombstones and dormant stubs come with their last data
 *  (`deleted`/`dormant` set), so a reader can apply its read check to them before sending. */
export function loadChanged(_tx: Transaction, _tabIds: string[], _since: Date, _kinds?: PartKind[]): Promise<Map<string, Part[]>> {
  return pending('loadChanged')
}
/** Dormant groups, newest activity first, 50 a page. */
export function loadDormant(_tx: Transaction, _tabId: string,
  _page: { projectId?: string; before?: { lastActivityAt: number; key: string } }): Promise<Part<GroupData>[]> {
  return pending('loadDormant')
}
/** The state commands run on: today's shape, parts in ordinal order, with the part-only group fields kept. */
export function reassemble(_parts: SwarmParts): SuperTabState { return pending('reassemble') }
/** The state in `SuperTab.state`'s shape: part-only group fields removed, report progress rebuilt as revisions
 *  (verification and rollback, section 6.2). */
export function toLegacyState(_state: SuperTabState): SuperTabState { return pending('toLegacyState') }
/** One Swarm's state as parts. */
export function split(_state: SuperTabState, _opts: { tabId: string; version: number; now: number }): SwarmParts { return pending('split') }
/** The newest data change of each Swarm, computed when read (section 3.7). */
export function lastChangedAt(_tx: Transaction, _tabIds: string[]): Promise<Map<string, number>> { return pending('lastChangedAt') }
