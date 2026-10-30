/** TypeScript mirror of the harness-pty wire protocol (pty/src/protocol.rs). */
import { createHash } from 'node:crypto'

/**
 * The protocol this daemon's host speaks (protocol.rs `PROTOCOL`). A host's instance is `p<protocol>-<version>`, so
 * hosts of one protocol and different builds run side by side (instance.ts); one from before that is `p<protocol>`.
 *
 * - 2: the `shutdown` op, for draining a host of the protocol before.
 * - 1: the first.
 *
 * The rule for a bump: this daemon must keep a client for the protocol before it (`SUPPORTED_PTY_PROTOCOLS`). A host
 * of that protocol may still hold the person's panes after an update; it is a drain backend (ptyHost/drain.ts) until
 * they close, and this client speaks its protocol to it, the hello included. An op added at N is gated on the host's
 * protocol (`PtyHostClient.protocol`, as `shutdown` is), and an op N changes must keep its N−1 form here.
 */
export const PTY_PROTOCOL = 2
/** The protocols whose hosts this daemon reaches: its own, which new panes go to, and the one before, drained. */
export const SUPPORTED_PTY_PROTOCOLS: readonly number[] = [PTY_PROTOCOL - 1, PTY_PROTOCOL].filter((p) => p >= 1)
/** The first protocol with the `shutdown` op. */
export const SHUTDOWN_PROTOCOL = 2
/**
 * The feature a host lists (its hello reply's and `harness-pty version`'s `features`) when its `create` takes a
 * `seed`: added within protocol 2, so a host's protocol does not say it. A host that lists no features has none.
 */
export const SEED_FEATURE = 'seed'
export const MAX_FRAME = 8 * 1024 * 1024

export enum FrameKind {
  Subscribe = 1,
  Input = 2,
  Paste = 3,
  Resize = 4,
  Snapshot = 5,
  Pause = 6,
  Resume = 7,
  Output = 16,
  SnapshotReply = 17,
  Closed = 18,
  Ack = 19,
}

export type PtyErrorCode =
  | 'no_pane'
  | 'bad_request'
  | 'spawn_failed'
  | 'held_mismatch'
  | 'unsupported'
  | 'internal'

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Buffer {
  if (payload.length > MAX_FRAME) throw new Error('frame too large')
  const out = Buffer.allocUnsafe(5 + payload.length)
  out.writeUInt8(kind, 0)
  out.writeUInt32BE(payload.length, 1)
  out.set(payload, 5)
  return out
}

export interface Frame {
  kind: FrameKind
  payload: Buffer
}

/**
 * Accumulates socket chunks and yields complete frames. A frame whose length
 * exceeds MAX_FRAME (8 MiB) or whose kind is unknown makes `push` throw; the
 * reader is then unusable and the connection must be dropped.
 *
 * Chunks wait in a list and each byte is copied once more, into its frame: joining the
 * whole backlog on every chunk would make an 8 MiB frame read in 1 KiB chunks quadratic.
 */
export class FrameReader {
  private chunks: Buffer[] = []
  /** Bytes of `chunks[0]` already consumed. */
  private offset = 0
  private size = 0

  push(chunk: Uint8Array): Frame[] {
    // A copy: the caller may reuse its buffer once push returns.
    if (chunk.length > 0) {
      this.chunks.push(Buffer.from(chunk))
      this.size += chunk.length
    }
    const frames: Frame[] = []
    while (this.size >= 5) {
      const head = this.peekHeader()
      const kind = head.readUInt8(0)
      const len = head.readUInt32BE(1)
      if (len > MAX_FRAME) throw new Error('frame too large')
      if (FrameKind[kind] === undefined) throw new Error(`unknown frame kind ${kind}`)
      if (this.size < 5 + len) break
      this.take(5)
      frames.push({ kind: kind as FrameKind, payload: this.take(len) })
    }
    return frames
  }

  private peekHeader(): Buffer {
    const first = this.chunks[0]
    if (first.length - this.offset >= 5) return first.subarray(this.offset, this.offset + 5)
    const head = Buffer.allocUnsafe(5)
    let at = 0
    let offset = this.offset
    for (let i = 0; at < 5; i++, offset = 0) {
      at += this.chunks[i].copy(head, at, offset, Math.min(this.chunks[i].length, offset + 5 - at))
    }
    return head
  }

  /** Remove `n` bytes (n <= size) from the front, as a buffer of their own. */
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let at = 0
    let used = 0
    while (at < n) {
      const first = this.chunks[used]
      const copied = first.copy(out, at, this.offset, Math.min(first.length, this.offset + n - at))
      at += copied
      this.offset += copied
      if (this.offset === first.length) {
        used++
        this.offset = 0
      }
    }
    if (used > 0) this.chunks.splice(0, used)
    this.size -= n
    return out
  }
}

export type HelloRole = 'control' | 'stream'
/**
 * A client's hello (pty/src/protocol.rs `Hello`). It never carries the token: whatever listens on the endpoint reads
 * it, and that may be a process squatting on the name. `nonce` is 32 random bytes as 64 hex digits; `auth` is
 * `helloAuth(token, nonce)`, and the reply's `proof` is `helloProof(token, nonce)`.
 */
export interface HelloLine {
  hello: { auth: string; nonce: string; protocol: number; role: HelloRole; clientId: string }
}
export type HelloReply =
  | { hello: { ok: true; instance: string; version: string; pid: number; features?: string[]; proof: string } }
  | { hello: { ok: false; code: string; reason: string } }

const tokenDigest = (token: string, separator: string, nonce: string) =>
  createHash('sha256').update(token).update(separator).update(nonce).digest('hex')

/** The client's `auth` for [nonce] (protocol.rs `hello_auth`): hex SHA-256(token || 0x01 || nonce). */
export function helloAuth(token: string, nonce: string): string {
  return tokenDigest(token, '\u0001', nonce)
}

/**
 * The `proof` a host's hello reply carries for [nonce] (protocol.rs `hello_proof`): hex SHA-256(token || 0x00 ||
 * nonce). Only a host that knows the token can give it, so a process squatting on the endpoint cannot pass for the
 * host; the separators differ from `helloAuth`'s, so neither can be passed off as the other.
 */
export function helloProof(token: string, nonce: string): string {
  return tokenDigest(token, '\0', nonce)
}

export interface PaneInventoryRow {
  pane: string
  /** The current child's pid, or the last one's once it has exited (a held, dead pane), as tmux keeps a dead
   *  pane's `#{pane_pid}`; null only where the host never learned one. */
  rootPid: number | null
  cwd: string
  title: string
  dead: boolean
  /** The `owner` and `label` given at `create`. */
  owner: string
  label: string | null
}
export interface PaneStateInfo {
  dead: boolean
  exitStatus: number | null
  command: string[]
  engineExit: number | null
  /** `command` joined by single spaces: tmux's `#{pane_start_command}`, which a held shell is told by
   *  (nativePaneHold.ts `heldPaneFormat`). */
  startCommand: string
}
export interface PaneInfo {
  command: string
  path: string
  /** null once the pane's process has exited. */
  pid: number | null
  tty: string
}

/** `create`'s and `respawn`'s `afterExit` (pty/src/protocol.rs `AfterExit`): what the pane runs once its child exits by
 *  itself, the status recorded as its `engineExit` and given to it as `HARNESS_ENGINE_EXIT`. */
export interface PtyAfterExit {
  command: string[]
  env?: Record<string, string>
}

export type PtyOp =
  | { op: 'create'; command: string[]; cwd?: string; env?: Record<string, string>; cols: number; rows: number; owner: string; label?: string; hold: boolean; afterExit?: PtyAfterExit; clearInherited?: string[]; /** Scrollback the pane starts with: lines separated by \n or \r\n. Send only to a host listing the `seed` feature. */ seed?: string }
  | { op: 'kill'; pane: string; graceMs?: number }
  | { op: 'inventory' }
  | { op: 'titles' }
  | { op: 'paneState'; pane: string }
  | { op: 'paneInfo'; pane: string }
  | { op: 'capture'; pane: string; historyLines?: number; ansi: boolean; visible: boolean }
  | { op: 'write'; pane: string; data: string }
  | { op: 'paste'; pane: string; text: string; bracketed: boolean }
  | { op: 'key'; pane: string; key: string }
  | { op: 'setTitle'; pane: string; title: string }
  | { op: 'holdOpen'; pane: string }
  | { op: 'releaseHold'; pane: string }
  | { op: 'respawn'; pane: string; command: string[]; cwd?: string; env?: Record<string, string>; expectedHeldToken?: string; clearEnv?: string[]; clearInherited?: string[]; afterExit?: PtyAfterExit }
  | { op: 'jobPids'; pane: string }
  | { op: 'processes' }
  | { op: 'setEngineExit'; pane: string; status: number }
  /** Protocol 2 (`SHUTDOWN_PROTOCOL`): the host replies, then exits, but only with no pane at all; else `bad_request`. */
  | { op: 'shutdown' }

export type PtyOpName = PtyOp['op']
export type PtyOpOf<K extends PtyOpName> = Extract<PtyOp, { op: K }>
export type PtyRequest = { id: number } & PtyOp

export interface PtyOpReplies {
  create: { pane: string }
  kill: Record<string, never>
  inventory: { panes: PaneInventoryRow[] }
  titles: { titles: Record<string, string> }
  paneState: { state: PaneStateInfo | 'gone' }
  /** A pane the host does not have is a `no_pane` failure, never a null `info`. */
  paneInfo: { info: PaneInfo }
  capture: { text: string }
  write: Record<string, never>
  paste: Record<string, never>
  key: Record<string, never>
  setTitle: Record<string, never>
  holdOpen: Record<string, never>
  releaseHold: Record<string, never>
  respawn: Record<string, never>
  jobPids: { pids: number[] }
  processes: { rows: unknown[] }
  setEngineExit: Record<string, never>
  shutdown: Record<string, never>
}

/** The reply line to a request for op `K`. */
export type PtyResponse<K extends PtyOpName = PtyOpName> =
  | ({ id: number; ok: true } & PtyOpReplies[K])
  | { id: number; ok: false; code: PtyErrorCode; reason: string }

export type PtyEvent =
  /** `status` is null when the host could not learn it. */
  | { event: 'exit'; pane: string; status: number | null }
  | { event: 'title'; pane: string; title: string }

/* Stream connection payloads (pty/src/stream.rs). */

/** `FrameKind.Subscribe`. A subscriber that is not read-only resizes the pane to itself. */
export interface StreamSubscribe {
  pane: string
  cols: number
  rows: number
  readOnly: boolean
}
/** `FrameKind.Resize`. */
export interface StreamResize {
  cols: number
  rows: number
}
/**
 * `FrameKind.Snapshot`. `historyLines` defaults to 2000 for `conversation` and 500 otherwise;
 * `none` sends no history.
 */
export interface StreamSnapshotRequest {
  id: number
  history: 'none' | 'plain' | 'conversation'
  historyLines?: number
}
/** `PaneMeta` as the host sends it (snake_case). */
export interface PtyPaneMeta {
  cols: number
  rows: number
  alternate_on: boolean
  cursor_x: number
  cursor_y: number
  cursor_visible: boolean
  mouse_standard: boolean
  mouse_button: boolean
  mouse_all: boolean
  mouse_utf8: boolean
  mouse_sgr: boolean
}
/**
 * `FrameKind.SnapshotReply`. `capture` is `capture-pane -p -e -N` (one line per screen row) and
 * `history` is `capture-pane -p -e -N -S -<n> -E -1`. Output frames with `seq <= seq` that arrive
 * after the reply are already in it; every later output follows it.
 *
 * For `history: 'conversation'` the reply also carries the history as `capture-pane -p -e -J`
 * prints it (`historyJoined`) and whether its last line continues into the screen
 * (`lastContinues`, as read from `capture-pane -p -J -S -1 -E 0`). They are dropped, before any
 * plain history, from a reply that would not fit a frame.
 */
export type StreamSnapshotReply =
  | {
      id: number
      ok: true
      seq: number
      capture: string
      history: string
      historyJoined?: string
      lastContinues?: boolean
      meta: PtyPaneMeta
    }
  | { id: number; ok: false; reason: 'not_subscribed' | 'no_pane' | 'bad_request' }
/**
 * `FrameKind.Ack`, one per Subscribe, Input, Paste and Resize, in order; `for` is the acknowledged
 * frame's kind. A Resize ack's `seq` is the last output drawn at the old size. A Subscribe or Resize
 * ack says whether the pane's size changed (`resized`): not for a read-only subscriber, nor for a
 * size the pane already had (the host skips it, as tmux does, and the child gets no SIGWINCH).
 */
export type StreamAck =
  | { for: FrameKind; ok: true; seq?: number; resized?: boolean }
  | {
      for: FrameKind
      ok: false
      reason: 'not_subscribed' | 'already_subscribed' | 'read_only' | 'no_pane' | 'exited' | 'bad_request'
    }
/** `FrameKind.Closed`; the host ends the connection after it. */
export interface StreamClosed {
  reason: 'exited' | 'killed' | 'overflow'
}
