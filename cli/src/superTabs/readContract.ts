/**
 * The Swarm read API as the CLI reads it (docs/design/2026-10-26-swarm-state-parts.md section 4). Mirrored by hand from the
 * backend's `backend/src/superTabs/read/contract.ts`, the one source of truth; a change there is announced before it merges
 * (design 7.2). Times are epoch milliseconds. Part `data` keeps each record's own JSON shape.
 */
type Json = Record<string, unknown>

/** The only format this client reads (design 4.3). Another one is a newer server: Harness needs an update. */
export const READ_FORMAT = 2
export const UPDATE_REQUIRED = 'UPDATE_REQUIRED'
/** The text every client shows for HTTP 426 (design 4.11, 5.1). */
export const UPDATE_MESSAGE = 'Update Harness to keep using this Swarm.'

export type PartKind = 'head' | 'member' | 'agent' | 'group' | 'machine' | 'start' | 'progress'
/** Live parts carry `data`; a tombstone `deleted`, a group that went dormant `dormant` (design 4.1). */
export interface PartEnvelope<T = Json> {
  key: string
  version: number
  changedAt: number
  data?: T
  deleted?: true
  dormant?: true
}

/** Values the server recomputes for every response and the client overlays on the parts (design 4.1). */
export interface Derived {
  agents?: Record<string, Json>
  machines?: Record<string, Json>
  otherProjectsWork?: Json[]
  mentionsWaiting?: number
}

/** What first load and changes share: the parts by kind, `head` null in changes when it did not change. */
export interface PartsPayload {
  format: number
  cursor: string
  serverTime: number
  lastChangedAt: number
  epoch: number
  head: PartEnvelope | null
  members: PartEnvelope[]
  agents: PartEnvelope[]
  groups: PartEnvelope[]
  machines: PartEnvelope[]
  starts: PartEnvelope[]
  progress: PartEnvelope[]
  derived: Derived
}
/** `GET /api/super-tabs/:tabId/parts` (design 4.3). */
export interface FirstLoad extends PartsPayload { tabId: string; githubApp?: boolean }
/** `GET /api/super-tabs/:tabId/changes?cursor=` (design 4.4); `{ reload: true }` asks for a first load instead. */
export type ChangedParts = PartsPayload & { reload: false }
export type Changes = ChangedParts | { reload: true }

/** `GET /api/super-tabs/list` (design 4.9). */
export interface ListPage { tabs: Array<{ id: string; name: string; ownerId: string; paused: boolean; lastChangedAt: number }>; next: string | null }

/** One Swarm's rows in `GET /api/super-tabs/hosts/:machineId/changes` (design 4.10): today's roster, pools and assignments. */
export interface HostTab { tabId: string; lastChangedAt: number; roster: Json[]; pool: Json | null; assignments: Json[] }
export interface HostChanges { format: number; full: boolean; cursor: string; tabs: HostTab[]; removedTabIds: string[] }

/** The `(sequence, id)` page cursor of a conversation's messages (design 4.6). */
export interface MessagePage { messages: Json[]; next: { sequence: number; id: string } | null }
