/**
 * This machine's viewers, served to a client that cannot reach its loopback: the phone, the web, a window
 * on another of the owner's machines. Such a client asks for a viewer's pages over its own connection
 * (`viewer_request` and the stream's frames after it) or asks for a rendered frame of it
 * (`viewer_surface`), and the viewers answer it (services/viewers.ts): in their own process by default,
 * where the viewer servers already run, or in this one.
 *
 * The socket hands every such frame here, after its gates, and nothing here waits: a stream's frame is
 * passed on as it comes, and its answers go back to that one connection when the viewers send them
 * (`CoreApi.clients.viewerFrame`). While the viewers are off, hung behind a full socket or failing, a
 * stream is refused at once with `viewer_close`, so a client never waits out its own timeout for a viewer
 * nobody is serving, and a surface is answered unavailable.
 */
import { viewerStreamId } from '../lib/viewerFrames.js'
import { VIEWERS_UNAVAILABLE, type ViewersPort } from './api.js'

export interface ViewerStreams {
  /** A client's frame of a viewer stream. */
  frame(connId: string, type: string, payload: Record<string, unknown>): void
  /** A client's `viewer_surface`, answered as its reply. */
  surface(connId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** A client's connection ended. */
  closed(connId: string): void
  /** Every client's did: the link went down, or the socket is stopping. */
  closedAll(): void
}

/** What a stream nobody serves is told: the same words the viewers use for a viewer that is gone. */
export const NOT_SERVED = 'Viewer is no longer available'

export function createViewerStreams(
  /** The viewers' port as it is now: null while they are off. */
  viewers: () => Pick<ViewersPort, 'stream' | 'surface' | 'closed'> | null,
  /** A frame to one connection, as the viewers' own answers go. */
  send: (connId: string, type: string, payload: Record<string, unknown>) => boolean,
): ViewerStreams {
  return {
    frame: (connId, type, payload) => {
      if (viewers()?.stream(connId, type, payload)) return
      // A close needs no answer; any other frame of a stream nobody holds now ends it on the client's side.
      if (type !== 'viewer_close' && viewerStreamId(payload.streamId)) send(connId, 'viewer_close', { streamId: payload.streamId, error: NOT_SERVED })
    },
    surface: async (connId, payload) => (await viewers()?.surface(connId, payload)) ?? VIEWERS_UNAVAILABLE,
    closed: (connId) => { viewers()?.closed(connId) },
    closedAll: () => { viewers()?.closed() },
  }
}
