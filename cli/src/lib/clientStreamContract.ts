/** Public stream spellings and transport budgets. Implementations live in their service processes. */
export type StreamPayload = Record<string, unknown>
export interface StreamAsker {
  local: boolean
  owner: boolean
  accountOwner?: boolean
  guest?: string
  connection?: string
}

export interface ClientStreamSpec {
  service: string
  wakeField: 'dsh' | 'browser'
  open: string
  opened?: string
  close: string
  ack: string
  end?: string
  down: readonly string[]
  up: readonly string[]
  reservedPrefix?: string
  transport: 'target' | 'terminal'
  audience: 'owner' | 'account'
  ids: 'client' | 'reply'
  grants: number
  perConnection: number
  pending: number
  pendingPerConnection: number
  idBytes: number
  connectionIdBytes: number
  waitMs: number
  firstStart: boolean
  binary?: { kind: number; chunkBytes: number; unreadBytes: number }
  refused: { disabled: string; unavailable: string; limit: string; denied?: string }
  closed: { unavailable: StreamPayload; failedInput: StreamPayload; failedOutput: StreamPayload }
}

export const CLIENT_STREAMS: readonly ClientStreamSpec[] = [
  {
    service: 'viewers', wakeField: 'dsh', open: 'viewer_request', close: 'viewer_close', ack: 'viewer_ack', end: 'viewer_end',
    down: ['viewer_request', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'],
    up: ['viewer_response', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'],
    reservedPrefix: 'viewer_', transport: 'target', audience: 'owner', ids: 'client', grants: 256, perConnection: 64, pending: 256, pendingPerConnection: 64,
    idBytes: 1024 * 1024, connectionIdBytes: 256 * 1024, waitMs: 30_000, firstStart: true,
    refused: { disabled: 'Viewer is no longer available', unavailable: 'Viewer is no longer available', limit: 'Too many viewer requests' },
    closed: { unavailable: { error: 'Viewer is no longer available' }, failedInput: { error: 'Viewer is no longer available' }, failedOutput: { error: 'Viewer connection closed' } },
  },
  {
    // The browser row flag is public migration input until 2026-12-18.
    service: 'agentBrowser', wakeField: 'browser', open: 'agent_browser_open', opened: 'agent_browser_open_result', close: 'agent_browser_close', ack: 'agent_browser_ack',
    down: ['agent_browser_open', 'agent_browser_ack', 'agent_browser_close'], up: ['agent_browser_open_result', 'agent_browser_close'],
    transport: 'terminal', audience: 'account', ids: 'reply', grants: 2048, perConnection: 256, pending: 512, pendingPerConnection: 8,
    idBytes: 8 * 1024 * 1024, connectionIdBytes: 4 * 1024 * 1024, waitMs: 10_000, firstStart: false,
    binary: { kind: 8, chunkBytes: 512 * 1024 - 24, unreadBytes: 1024 * 1024 },
    refused: { disabled: 'NO_BROWSER', unavailable: 'NOT_READY', limit: 'VIEWER_LIMIT', denied: 'NOT_OWNER' },
    closed: { unavailable: { reason: 'agent' }, failedInput: { reason: 'agent' }, failedOutput: { reason: 'backlog' } },
  },
]

/** Independent shares: one feature can fill its queue without spending another feature's reservation. */
export const CLIENT_STREAM_QUEUE_BYTES = 4 * 1024 * 1024
export const CLIENT_STREAM_QUEUE_FRAMES = 4096
export const CLIENT_STREAM_HELD_FRAMES = 4096
export const CLIENT_STREAM_CONTROL_BYTES = 256

/** Private stream transport. A grant is issued by core, and never selected from the client's payload. */
export interface ClientStreamEvent {
  grant: string
  connection: string
  type: string
  payload: StreamPayload
  asker: StreamAsker
}

export interface ClientStreamEndpoint {
  frame(event: ClientStreamEvent): boolean
  binary(frame: Uint8Array): boolean
  closed(connection?: string): void
  control(grant: string | null, payload: StreamPayload): void
  refused(grant: string, streamId?: string, connection?: string): void
}

export interface ClientStreamSink {
  frame(grant: string, type: string, payload: StreamPayload): boolean
  binary(frame: Uint8Array): boolean
}

export function clientStreamId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value)
}

export function replyStreamId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}
