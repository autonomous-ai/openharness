import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Command } from '../../src/superTabs/commands.js'
import type { MachineObservation } from '../../src/superTabs/machines.js'

/**
 * The seam between the scenario and a store (#1726 group 0).
 *
 * The scenario only says what a client does: run a command, report a machine, record a terminal turn, take a delivery,
 * poll. A driver says how the clients of one store version do it. Today's driver (legacyDriver.ts) uses today's routes;
 * the parts store (groups 2–3) adds its own driver, e.g. readers that poll by cursor, and the scenario stays unchanged.
 * Commands keep their shapes across versions (spec: "Keep the existing behavior of every command"), so they cross the
 * seam as they are.
 */
export interface SwarmDriver {
  readonly name: string
  /** A new Swarm owned by [owner]; returns its id. */
  createSwarm(owner: AuthUser, operationId: string, name: string): Promise<Reply<{ id: string }>>
  /** A command as a person, or as an agent when [asAgentId] is set (the agent's execution host signs in). */
  execute(tabId: string, user: AuthUser, operationId: string, command: Command, asAgentId?: string): Promise<Reply<CommandResult>>
  /** What setup needs to read back: group checks, the Lead, assignments, machine generations, in today's state shape. */
  snapshot(tabId: string, user: AuthUser): Promise<Snapshot>
  /** A machine's contribution generation, as its host reads it before reporting. */
  machineGeneration(tabId: string, host: AuthUser, machineId: string): Promise<string>
  observeMachine(tabId: string, host: AuthUser, machineId: string, observation: MachineObservation): Promise<Reply>
  /** A person opens an agent's terminal in a group; its host then records the turns. */
  openNative(tabId: string, opener: AuthUser, input: { operationId: string; conversationId: string; agentId: string }): Promise<Reply<{ contextId: string }>>
  appendNative(tabId: string, host: AuthUser, contextId: string, event: NativeEvent): Promise<Reply<{ eventId: string }>>
  /** The deliveries waiting for an agent, as its host reads them on each pass. */
  deliveries(tabId: string, host: AuthUser, agentId: string): Promise<Reply<Array<{ id: string }>>>
  delivery(tabId: string, host: AuthUser, agentId: string, deliveryId: string, action: DeliveryAction): Promise<Reply>
  /** A Desktop or web window open on the Swarm, polling every 3 s today. */
  desktopReader(tabId: string, person: AuthUser): Reader
  /** A CLI host's roster read, every 1 s today. */
  hostReader(host: AuthUser, machineId: string): Reader
  /** What the Swarm's state costs to store: the documents that hold it and their total BSON size. */
  stateSize(tabId: string): Promise<{ bytes: number; documents: number }>
  close(): Promise<void>
}

/** A client's view of one call. `code` is the error code (`SWARM_BUSY` and so on), null on success. */
export interface Reply<T = unknown> {
  status: number
  code: string | null
  data: T | null
  /** Response body size in bytes. */
  bytes: number
}

export interface Reader {
  readonly label: string
  /** One poll. A reader keeps whatever it needs between polls (a cursor, a version). */
  poll(): Promise<Reply>
}

export type CommandResult = { revision?: number; result: Record<string, unknown> }

export interface NativeEvent {
  turnId: string
  kind: 'prompt' | 'answer'
  previousEventId: string | null
  text: string
  truncated: boolean
  interrupted: boolean
}

export type DeliveryAction = { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }

/** The few facts setup reads back, independent of how a store keeps them. */
export interface Snapshot {
  conversations: Array<{ id: string; checks: Array<{ id: string }>; assignment: { id: string; agentId: string; status: string } | null }>
  agents: Array<{ id: string; machineId: string; harnessId: string }>
}
