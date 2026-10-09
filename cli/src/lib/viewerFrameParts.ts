import { TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'

/** One part's JPEG bytes: under the data channel's 512 KiB message limit once the plain header (34 bytes)
 *  and the seal (20 bytes + tag) are added. */
export const VIEWER_PART_BYTES = 480 * 1024
/** 16 parts ≈ 7.5 MB: far beyond the 4.2 Mpx cap at JPEG quality 75; anything bigger is a bug, not a frame. */
const MAX_PARTS = 16

/** A surface id the clients mint (16 random bytes as lowercase hex) in the UUID form a binary streamId takes.
 *  Any other id cannot ride the binary path and stays on the WS long-poll. */
export function surfaceStreamId(surfaceId: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(surfaceId)) return null
  return `${surfaceId.slice(0, 8)}-${surfaceId.slice(8, 12)}-${surfaceId.slice(12, 16)}-${surfaceId.slice(16, 20)}-${surfaceId.slice(20)}`
}

export function splitViewerFrame(surfaceId: string, seq: number, jpeg: Uint8Array,
  meta: { width: number; height: number; scale: number }): TerminalBinaryClear[] | null {
  const streamId = surfaceStreamId(surfaceId)
  const parts = Math.ceil(jpeg.length / VIEWER_PART_BYTES)
  if (!streamId || parts === 0 || parts > MAX_PARTS) return null
  return Array.from({ length: parts }, (_, part) => ({
    kind: TerminalBinaryKind.viewerFrame, streamId, seq, compressed: false,
    bytes: jpeg.subarray(part * VIEWER_PART_BYTES, (part + 1) * VIEWER_PART_BYTES),
    viewer: { part, parts, width: meta.width, height: meta.height, scale: meta.scale },
  }))
}
