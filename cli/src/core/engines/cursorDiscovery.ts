/**
 * Finding the transcript of a Cursor session that has not written one yet (engines/cursor/discovery.ts).
 *
 * Built on the first Cursor session an attach hands it, from Cursor's own code (engines/inProcess.ts), loaded by
 * that attach before it gets here: no other engine's daemon ever builds it. Until then nothing is pending, so a
 * start, a remove or a stop has nothing to act on but whether it is started. Without Cursor's code a session's
 * transcript is not looked for, as for any session whose engine's code could not be loaded.
 */
import type { CursorTranscriptDiscovery } from '../../engines/cursor/discovery.js'
import { engineNow } from '../../engines/inProcess.js'

export type CursorDiscovery = Pick<CursorTranscriptDiscovery, 'start' | 'add' | 'remove' | 'stop'>

/** `cursorHome` is named when the core starts, as it always was: the folder does not move with Cursor's load. */
export function createCursorDiscovery(cursorHome: string, onFound: (sessionId: string, transcriptPath: string) => void): CursorDiscovery {
  let built: CursorTranscriptDiscovery | null = null
  let started = false
  const build = (): CursorTranscriptDiscovery | null => {
    if (built) return built
    const cursor = engineNow('cursor', 'a session\'s transcript was looked for')
    if (!cursor) return null
    built = new cursor.CursorTranscriptDiscovery(cursorHome, onFound)
    // Started already, as the core starts it once at boot: the same state, then this session.
    if (started) void built.start()
    return built
  }
  return {
    start: async () => { started = true; await built?.start() },
    // Synchronously into Cursor's own `add`, so nothing changes about what a stop() in flight discards.
    add: async (sessionId) => { await build()?.add(sessionId) },
    remove: (sessionId) => built?.remove(sessionId),
    stop: async () => { started = false; await built?.stop() },
  }
}
