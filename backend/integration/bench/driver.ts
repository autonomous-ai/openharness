import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Command } from '../../src/superTabs/commands.js'
import type { MachineObservation } from '../../src/superTabs/machines.js'

/**
 * What the scenario's clients do, through the backend's routes (drivers/parts.ts): run a command (as a person or as an
 * agent), report a machine, take a delivery, poll. Commands cross as they are.
 */
export interface SwarmDriver {
  /** A new Swarm owned by [owner]; returns its id. */
  createSwarm(owner: AuthUser, operationId: string, name: string): Promise<Reply<{ id: string }>>
  /** A command as a person, or as an agent when [asAgentId] is set (the agent's execution host signs in). */
  execute(tabId: string, user: AuthUser, operationId: string, command: Command, asAgentId?: string): Promise<Reply<CommandResult>>
  /** The 1:1 chat an agent's add opened with its person (a PM's), as its stored agent names it; setup reads no route for it. */
  agentChat(tabId: string, agentId: string): Promise<string | null>
  /** A machine's contribution generation, as its host reads it before reporting. */
  machineGeneration(tabId: string, host: AuthUser, machineId: string): Promise<string>
  observeMachine(tabId: string, host: AuthUser, machineId: string, observation: MachineObservation): Promise<Reply>
  /** The deliveries waiting for an agent, as its host reads them on each pass. */
  deliveries(tabId: string, host: AuthUser, agentId: string): Promise<Reply<Array<{ id: string }>>>
  delivery(tabId: string, host: AuthUser, agentId: string, deliveryId: string, action: DeliveryAction): Promise<Reply>
  /** A Desktop window open on the Swarm, polling every 3 s. */
  desktopReader(tabId: string, person: AuthUser): Reader
  /** A CLI host's read of its rows, every 1 s. */
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
  /** One poll. A reader keeps whatever it needs between polls (a cursor, the etags it holds). */
  poll(): Promise<Reply>
}

export type CommandResult = { revision?: number; result: Record<string, unknown> }

export type DeliveryAction = { type: 'claim'; claimId: string } | { type: 'ack'; claimId: string; receipt: string; uncertain: boolean }
