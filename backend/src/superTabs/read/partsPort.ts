/**
 * Group 2's parts interface as the read API and the migration consume it (design section 7.2, plus loadAll, insertParts
 * and last data on tombstones and stubs, Lead's ruling (b)). Until `../parts/index.ts` lands this re-exports a typed stub;
 * then this file re-exports group 2's module and the stub goes.
 */
import type { Prisma } from '@prisma/client'
import type { Actor, AgentStart, Conversation, Person, Agent, SuperTabState } from '../model.js'
import type { ContributedMachine, MachineCleanup } from '../machines.js'
import type { SwarmProject } from '../projects.js'
import type { Audience, PartKind } from './contract.js'

export type { PartKind }
export type Transaction = Prisma.TransactionClient

/** One stored part. Tombstones and dormant groups keep their last `data` on the server (never sent to clients). */
export interface Part<T = unknown> {
  kind: PartKind; key: string; version: number; changedAt: number
  deleted?: true; dormant?: true; ordinal: number; data: T | null
}
export type HeadData = Omit<SuperTabState, 'people' | 'agents' | 'conversations' | 'starts' | 'machines' | 'harnessReservations'
  | 'releasedHarnesses' | 'closingSessions' | 'machineCleanups' | 'parkedConversations' | 'otherProjectsWork' | 'projects'>
  & { projects?: Array<Omit<SwarmProject, 'progress'>> }
export type GroupData = Conversation & { messageSeq: number; reportSeq: number; dormant: boolean; lastActivityAt: string; audience?: Audience }
export interface MachineData {
  machineId: string
  contribution: ContributedMachine | null
  reservations: Array<{ harnessId: string; generation: string; renewed: boolean }>
  released: string[]
  closingSessions: Array<{ agentId: string; harnessId: string; machineOwnerId: string }>
  cleanups: Array<Omit<MachineCleanup, 'machineId'>>
}
export interface ProgressData {
  since: number
  summarizedFloor: number
  summarized: Record<string, number>
  requestedFloor: number
  requested: Record<string, number>
  requestedAt?: number
  requestMessageId?: string
}
export interface SwarmParts {
  head: Part<HeadData>; members: Part<Person>[]; agents: Part<Agent>[]; groups: Part<GroupData>[]
  machines: Part<MachineData>[]; starts: Part<AgentStart>[]; progress: Part<ProgressData>[]; sequenceBase: number; epoch: number
}

export interface PartsModule {
  loadActive(tx: Transaction, tabId: string, opts?: { groupIds?: string[]; agentIds?: string[] }): Promise<SwarmParts>
  /** Every part with changedAt > since, tombstones and dormant groups included, each with its last data. */
  loadChanged(tx: Transaction, tabIds: string[], since: Date, kinds?: PartKind[]): Promise<Map<string, Part[]>>
  loadDormant(tx: Transaction, tabId: string, page: { projectId?: string; before?: { lastActivityAt: number; key: string } }): Promise<Part<GroupData>[]>
  /** Every part of the Swarm: dormant groups, finished starts and tombstones included (verification, rollback). */
  loadAll(tx: Transaction, tabId: string): Promise<SwarmParts & { tombstones: Part[] }>
  insertParts(tx: Transaction, tabId: string, parts: SwarmParts): Promise<void>
  reassemble(parts: SwarmParts): SuperTabState
  split(state: SuperTabState, opts: { version: number; now: number; lastActivity: Map<string, number> }): SwarmParts
  lastChangedAt(tx: Transaction, tabIds: string[]): Promise<Map<string, number>>
  canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean
  clock: { next(): number }
}

export { parts } from './partsStub.js'
