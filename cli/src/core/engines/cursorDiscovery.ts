/** Transcript discovery is session control, present even when Cursor's optional readers cannot load. */
import { CURSOR_TRANSCRIPT, CURSOR_TRANSCRIPT_POLL_MS } from '../../engines/cursor/contract.js'
import { TranscriptDiscovery } from '../../engines/kit/transcriptDiscovery.js'
import { inspectTranscriptPath } from '../../lib/registry.js'

export type CursorDiscovery = Pick<TranscriptDiscovery, 'start' | 'add' | 'remove' | 'stop'>

export function createCursorDiscovery(cursorHome: string, onFound: (sessionId: string, transcriptPath: string) => void): CursorDiscovery {
  return new TranscriptDiscovery(cursorHome, CURSOR_TRANSCRIPT, onFound,
    path => inspectTranscriptPath('cursor', path), CURSOR_TRANSCRIPT_POLL_MS)
}
