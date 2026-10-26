import type { Agent, AgentStart, Conversation, Person, SuperTabState } from '../model.js'
import type { ContributedMachine } from '../machines.js'
import type { SwarmProject } from '../projects.js'

/** The part collections a Swarm is stored in (docs/design/2026-10-26-swarm-state-parts.md, section 2). */
export type PartKind = 'head' | 'member' | 'agent' | 'group' | 'machine' | 'start' | 'progress'
export const PART_KINDS: readonly PartKind[] = ['head', 'member', 'agent', 'group', 'machine', 'start', 'progress']

/** One stored part. `data` is null only on a tombstone read without its last data. */
export interface Part<T = unknown> {
  kind: PartKind
  key: string
  /** Moves on every write and every guarded touch; never resets. */
  version: number
  /** Epoch ms of the last data change (or tombstone). A touch leaves it. */
  changedAt: number
  deleted?: true
  dormant?: true
  ordinal: number
  data: T | null
}

/** A project as the head keeps it: its report progress lives in its own part. */
export type HeadProject = Omit<SwarmProject, 'progress'>

/** The head: everything in `SuperTabState` that is not one of the other parts. */
export type HeadData = Omit<SuperTabState, 'people' | 'agents' | 'conversations' | 'parkedConversations' | 'starts' | 'machines'
  | 'harnessReservations' | 'releasedHarnesses' | 'closingSessions' | 'machineCleanups' | 'otherProjectsWork' | 'projects'
  | 'groupCounter' | 'sequenceBase'> & { projects?: HeadProject[] }

/** A conversation with the fields only the part store keeps (section 2.2). */
export type GroupData = Conversation

/** Who may read a private conversation besides the project's Lead (section 4.8). */
export interface Audience { people: Array<{ id: string; generation: string }> }

/** One machine the Swarm references: its contribution (with observation), and its slot ledger. */
export interface MachineData {
  machineId: string
  contribution: ContributedMachine | null
  reservations: Array<{ harnessId: string; generation: string; renewed: boolean }>
  /** Harnesses a host proved stopped, oldest first, at most RELEASED_CAP. */
  released: string[]
  closingSessions: Array<{ agentId: string; harnessId: string; machineOwnerId: string }>
  cleanups: Array<{ removalId: string; machineOwnerId: string }>
}

/** One project's report watermark (section 3.6). Group sequences are per group; floors carry pre-split tab revisions. */
export interface ProgressData {
  /** When the project last went from clean to dirty. */
  since: number
  summarizedFloor: number
  summarized: Record<string, number>
  requestedFloor: number
  requested: Record<string, number>
  requestedAt?: number
  requestMessageId?: string
}

export interface SwarmParts {
  tabId: string
  head: Part<HeadData>
  members: Part<Person>[]
  agents: Part<Agent>[]
  groups: Part<GroupData>[]
  machines: Part<MachineData>[]
  starts: Part<AgentStart>[]
  progress: Part<ProgressData>[]
  /** The tab revision when the Swarm was split (0 for a Swarm born in parts). */
  sequenceBase: number
  visibilityEpoch: number
  groupCounter: number
}

/** Released harnesses kept per machine (spec, Archive). */
export const RELEASED_CAP = 200
/** Tombstones and finished starts are kept this long (spec rulings 5 and 6). */
export const RETENTION_MS = 7 * 86_400_000
/** A group with finished work and no message for this long leaves the active set (spec, Archive). */
export const DORMANT_AFTER_MS = 86_400_000
