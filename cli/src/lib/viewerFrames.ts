/**
 * A viewer stream's frame types and stream ids: what the core gates and hands on, without the stream
 * itself (lib/viewerWire.ts), which runs where the viewers do (services/viewers.ts). Kept apart so the
 * core's process, which only routes these frames, does not load the stream and its HTTP forwarding.
 */

/** Pairwise encrypted JSON frames; no payload may be logged or broadcast. */
export const VIEWER_DOWN_TYPES = new Set(['viewer_request', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'])
export const VIEWER_UP_TYPES = new Set(['viewer_response', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'])

/** The push surface's control frames (docs/superpowers/specs/2026-10-08-viewer-p2p-design.md), named apart
 * from the proxy's `viewer_*`. Sealed pairwise like the proxy's; no payload may be logged or broadcast. */
export const SURFACE_DOWN_TYPES = new Set(['surface_open', 'surface_input', 'surface_ack', 'surface_close'])
export const SURFACE_UP_TYPES = new Set(['surface_state', 'surface_error'])

export function viewerStreamId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value)
}
