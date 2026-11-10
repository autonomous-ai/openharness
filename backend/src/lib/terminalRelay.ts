import type { Frame } from './tunnel.js'

export const TERMINAL_ENVELOPE_MAX_BYTES = 512 * 1024
export const TERMINAL_DOWN_TYPES = new Set([
  'terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack',
  'terminal_input', 'terminal_resize', 'terminal_resync', 'terminal_close', 'terminal_scroll',
  'terminal_chunked_upload_begin', 'terminal_chunked_upload_cancel',
])

export const TERMINAL_UP_TYPES = new Set([
  'terminal_capabilities_result', 'terminal_ready', 'terminal_keyframe',
  'terminal_output', 'terminal_closed', 'terminal_error', 'terminal_paste_image_result',
  'terminal_paste_file_result', 'terminal_chunked_upload_begin_result',
  'terminal_chunked_upload_progress',
])

/** An agent browser stream's control frames (cli e2ee/applicationFrames.ts), sealed like terminal frames. Its bytes
 *  are binary kind 8. Kept apart from the terminal lists so a refusal names the browser, never a terminal. */
export const AGENT_BROWSER_DOWN_TYPES = new Set(['agent_browser_open', 'agent_browser_ack', 'agent_browser_close'])
export const AGENT_BROWSER_UP_TYPES = new Set(['agent_browser_open_result', 'agent_browser_close'])

export function terminalFrameBytes(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

export function terminalFrameNeedsWake(type: string): boolean {
  return type === 'terminal_open'
}

/** Backend may inspect only enough envelope structure to fail closed; ciphertext remains opaque. */
export function isEncryptedTerminalFrame(frame: Frame): boolean {
  const payload = frame.payload
  if (!payload || typeof payload !== 'object') return false
  const envelope = (payload as { __e2e?: unknown }).__e2e
  if (!envelope || typeof envelope !== 'object') return false
  const value = envelope as { v?: unknown; n?: unknown; k?: unknown; ct?: unknown }
  return value.v === 1
    && Number.isSafeInteger(value.n)
    && (value.k === 'p' || value.k === 'g')
    && typeof value.ct === 'string'
}

/**
 * One TerminalRateGuard serves a whole socket (a web client's connection, or a machine's adapter), so
 * every stream on it shares each bucket below. The backend cannot split them: terminal frames are
 * E2EE and the stream id is inside the ciphertext. The ack and output buckets were once sized for a
 * single busy stream, and three panes of one machine streaming over the relay tripped them. A rejected
 * ack answers TERMINAL_FRAME_REJECTED, which every pane on the socket reads as transport loss and shows
 * as Reconnect (2026-10-16). They are now sized for this many busy streams per socket: 16 was still
 * reachable by one person driving many harnesses on one machine, so it was raised the same day. Each
 * frame costs a parse and a Redis publish, so cutting frames at the source (fewer acks, coarser relay
 * flushes) is the way past this, not another raise.
 */
export const RELAY_BUSY_STREAMS = 64
/** A renderer acks once per 16 ms render window, plus once per 64 KiB rendered, while output flows. */
const ACKS_PER_STREAM_PER_MINUTE = 3_750
/** The daemon flushes a remote stream's output at most every 8 ms (`OUTPUT_FLUSH_MS` in the CLI). */
const OUTPUT_FRAMES_PER_STREAM_PER_MINUTE = 7_500
/** A machine's browser bytes on the relay: 512 KiB a second (agent browser spec, "Stream profiles by route"). */
const BROWSER_OUTPUT_BYTES_PER_MINUTE = 512 * 1024 * 60
/** How many drawn bytes a viewer acks at once (the CLI's browser stream). */
const BROWSER_ACK_STEP_BYTES = 64 * 1024

interface Bucket {
  startedAt: number
  frames: number
  bytes: number
}

function limits(type: string): { frames: number; bytes: number } {
  if (type === 'terminal_input') return { frames: 15_000, bytes: 64 * 1024 * 1024 }
  // The byte cap scales with the frame cap at ~1 KiB per frame (a typical compressed, sealed flush),
  // so neither binds first for legitimate traffic: 8 MiB per busy stream per minute.
  if (type === 'terminal_output') {
    return { frames: RELAY_BUSY_STREAMS * OUTPUT_FRAMES_PER_STREAM_PER_MINUTE, bytes: RELAY_BUSY_STREAMS * 8 * 1024 * 1024 }
  }
  if (type === 'terminal_sync') return { frames: 1_200, bytes: 8 * 1024 * 1024 }
  // Acks are renderer flow control, not user actions, and cannot be dropped quietly: the host pauses
  // output at 384 KiB unacknowledged and closes the stream (TERMINAL_RENDER_STALLED) if the ack that
  // would resume it never arrives. Sharing the human-paced 1,200 below once let a single pane
  // streaming a build log exhaust the window in about 19 seconds. A worst-case encrypted ack is
  // 216 B (pinned in terminalRelay.test.ts), so 1 MiB per busy stream per minute holds its 3,750.
  if (type === 'terminal_ack') {
    return { frames: RELAY_BUSY_STREAMS * ACKS_PER_STREAM_PER_MINUTE, bytes: RELAY_BUSY_STREAMS * 1024 * 1024 }
  }
  if (type === 'terminal_alive' || type === 'terminal_resize' || type === 'terminal_scroll') {
    return { frames: 1_200, bytes: 8 * 1024 * 1024 }
  }
  if (type === 'terminal_open' || type === 'terminal_capabilities') return { frames: 60, bytes: 4 * 1024 * 1024 }
  // Agent browser streams (spec 2026-11-10-agent-browser-design, "Nothing is dropped silently"), in buckets of their own
  // so a busy browser never throttles a terminal. `agent_browser_output` is a machine's kind-8 bytes, all its browsers
  // and viewers together: the most the relay carries for one machine, which its daemon paces under. The frame cap lets
  // the byte cap bind first for any frame of 1 KiB or more.
  if (type === 'agent_browser_output') return { frames: BROWSER_OUTPUT_BYTES_PER_MINUTE / 1024, bytes: BROWSER_OUTPUT_BYTES_PER_MINUTE }
  // A viewer's kind-8 bytes: keys, pointer and clipboard, about 1 KB/s in the first spike. Frames as terminal input.
  if (type === 'agent_browser_input') return { frames: 15_000, bytes: 64 * 1024 * 60 }
  // The viewer acks every 64 KiB it has drawn, at most 8 a second at the machine budget. A refused ack would stall its
  // stream until the backlog close, so twice that passes.
  if (type === 'agent_browser_ack') return { frames: 2 * (BROWSER_OUTPUT_BYTES_PER_MINUTE / BROWSER_ACK_STEP_BYTES), bytes: 1024 * 1024 }
  if (type === 'agent_browser_open' || type === 'agent_browser_open_result' || type === 'agent_browser_close') {
    return { frames: 120, bytes: 4 * 1024 * 1024 }
  }
  return { frames: 600, bytes: 64 * 1024 * 1024 }
}

/**
 * Tells the sender of a refused browser frame, at most once a second per socket. The backend cannot name the stream
 * (its id is inside the ciphertext), so the sender closes every browser stream it has on the relay. Every drop asks
 * again, so a stream opened after the last notice is told too.
 */
export function browserRateNotice(send: (frame: Frame) => void, now: () => number = () => Date.now()): () => void {
  let sentAt = Number.NEGATIVE_INFINITY
  return () => {
    const at = now()
    if (at - sentAt < 1_000) return
    sentAt = at
    send({ type: 'agent_browser_transport_error', payload: { code: 'RATE' } })
  }
}

/** Socket-local one-minute guard. It never stores terminal payloads and has no cross-request persistence. */
export class TerminalRateGuard {
  private readonly buckets = new Map<string, Bucket>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(type: string, bytes: number): boolean {
    const timestamp = this.now()
    let bucket = this.buckets.get(type)
    if (!bucket || timestamp - bucket.startedAt >= 60_000) {
      bucket = { startedAt: timestamp, frames: 0, bytes: 0 }
      this.buckets.set(type, bucket)
    }
    const limit = limits(type)
    if (bucket.frames + 1 > limit.frames || bucket.bytes + bytes > limit.bytes) return false
    bucket.frames++
    bucket.bytes += bytes
    return true
  }
}
