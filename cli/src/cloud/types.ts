/**
 * What a cloud agent's adapter does (docs/design/2026-10-11-cloud-agents.md, "The adapter"): it only
 * translates between Harness and one maker's API. The service (cloud/service.ts) does the rest: the
 * harnesses and their transcripts, how often to look, the questions, and what the core is told.
 */
import type { CloudAgentId, CloudProviderStatus, CloudState } from '../lib/cloudAgents.js'

export interface CloudLink { label: string; url: string }

/** A message from the agent. The person's own are recorded by the service as they are sent. */
export interface CloudMessage { id: string; text: string; at: string }

/** Where the maker's conversation is: its ids and how far it has been read. The service keeps it. */
export interface Remote {
  /** The maker's id for the conversation or session. */
  id: string
  /** The run or request in flight, where the maker has one (Cursor's runs, Fo's pending reply). */
  run?: string
  /** How far its messages have been read. */
  cursor?: string
}

/** What one look at the maker found: what is new, and where the harness is now. Absent fields are unchanged. */
export interface CloudUpdate {
  messages: CloudMessage[]
  state?: CloudState
  activity?: string | null
  /** The maker's own status and detail, when this look read them. A null field is a reading, not "leave the old one". */
  providerStatus?: CloudProviderStatus
  /** The agent waits on the person: what it asks, with the choices it offers. Absent: the question already asked stands. */
  question?: { text: string; choices: string[] } | null
  branch?: string | null
  links?: CloudLink[]
  remote?: Partial<Remote>
  /** The adapter waited for news itself (Fo's reply waits up to 40 s): look again at once, not after a pause. */
  waited?: boolean
}

export interface StartRequest {
  task: string
  /** `owner/name`, for a coding agent. */
  repository: string | null
  /** Devin's ACU limit, Cursor's model. */
  options: { acuLimit?: number; model?: string }
}

export interface CloudAdapter {
  readonly id: CloudAgentId
  start(request: StartRequest, signal?: AbortSignal): Promise<{ remote: Remote; links: CloudLink[]; update?: CloudUpdate }>
  /** A follow-up or an answer. What it returns replaces parts of the remote (a new run). */
  send(remote: Remote, text: string): Promise<Partial<Remote> | void>
  /** One bounded look: never longer than about a minute. */
  poll(remote: Remote, signal?: AbortSignal): Promise<CloudUpdate>
  /** Whether a reply already came with the words (Fo's `ask_fo` can answer with it), for a look at once. */
  answered?(remote: Remote): boolean
  /** Absent where the maker offers no way to stop it: Fo keeps working on its own. */
  stop?(remote: Remote): Promise<void>
}

/** A refusal said to the person as it is: "Connect Fo in Connections", "Cursor is still working". */
export class CloudError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
