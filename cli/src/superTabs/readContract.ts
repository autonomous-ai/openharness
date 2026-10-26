/**
 * The Swarm read API as the CLI reads it (docs/design/2026-10-26-swarm-state-parts.md section 4). Mirrored by hand from the
 * backend's `backend/src/superTabs/read/contract.ts` at cd004bf5c, the one source of truth; a change there is announced
 * before it merges (design 7.2). Records inside parts keep their JSON shape and are read as plain objects here. Times are
 * epoch milliseconds.
 */
type Json = Record<string, unknown>

/** The only format this client reads (design 4.3). Another one is a newer server: Harness needs an update. */
export const READ_FORMAT = 2
export const UPDATE_REQUIRED = 'UPDATE_REQUIRED'
/** The text every client shows for HTTP 426 (design 4.11, 5.1; the contract's `UPDATE_REQUIRED.message`). */
export const UPDATE_MESSAGE = 'Update Harness to keep using this Swarm.'

export type PartKind = 'head' | 'member' | 'agent' | 'group' | 'machine' | 'start' | 'progress'
/** A live part (`data`), a removed one (`deleted`, never with data), or a group that left the active set (`dormant`).
 *  A group's `data` has its own `messageSeq`, and `dormant`/`audience` only when set; an agent's never has the values that
 *  come in `derived` (`downSince`, `limitedUntil`, `roleId`). */
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
  /** Every agent the reader can see. `workDecision` null when the stored value stands; `roleId` null outside Custom. */
  agents: Record<string, { downSince: string | null; limitedUntil: string | null; workDecision: 'awaiting' | null; roleId: string | null }>
  /** Every contributed machine the reader can see. */
  machines: Record<string, Json>
  /** A Lead agent only. */
  otherProjectsWork?: Json[]
  /** A person only. */
  mentionsWaiting?: number
}

interface ReadMeta {
  format: number
  /** Opaque: unpadded base64url, sent back unchanged. */
  cursor: string
  serverTime: number
  /** The newest data change of any part of this Swarm; null for a Swarm with no parts yet. */
  lastChangedAt: number | null
  epoch: number
}
/** What first load and changes share: the parts by kind, `head` null in changes when it did not change. */
export interface PartsPayload extends ReadMeta {
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
export interface FirstLoad extends PartsPayload { tabId: string; githubApp?: true }
/** `GET /api/super-tabs/:tabId/changes?cursor=` (design 4.4); `{ reload: true }` asks for a first load instead. */
export type ChangedParts = PartsPayload & { reload: false }
export type Changes = ChangedParts | { reload: true }

/** `GET /api/super-tabs/list` (design 4.9). */
export interface ListPage { tabs: Array<{ id: string; name: string; ownerId: string; paused: boolean; lastChangedAt: number | null }>; next: string | null }

/** One Swarm's rows in `GET /api/super-tabs/hosts/:machineId/changes` (design 4.10): today's roster, pool and assignments. */
export interface HostTab { tabId: string; lastChangedAt: number | null; roster: Json[]; pool: Json | null; assignments: Json[] }
export interface HostChanges { format: number; full: boolean; cursor: string; tabs: HostTab[]; removedTabIds: string[] }

/** A conversation's messages, ordered by `(sequence, id)` (design 4.6). With no cursor, the newest 100, `next` naming the
 *  oldest row: sent back as `before` and `beforeId` for the page before. `next` is null at the end. */
export interface MessagePage { messages: Json[]; next: { sequence: number; id: string } | null }
