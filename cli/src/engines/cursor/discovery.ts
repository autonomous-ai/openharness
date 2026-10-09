/** Compatibility entry for optional Cursor consumers; session control uses the eager kit directly. */
import { inspectTranscriptPath } from '../../lib/registry.js'
import { TranscriptDiscovery } from '../kit/transcriptDiscovery.js'
import { locateTranscript } from '../kit/sessionLocation.js'
import { CURSOR_TRANSCRIPT, CURSOR_TRANSCRIPT_POLL_MS } from './contract.js'
export { CURSOR_TRANSCRIPT_POLL_MS } from './contract.js'

export class CursorTranscriptDiscovery extends TranscriptDiscovery {
  constructor(home: string, onFound: (sessionId: string, path: string) => void, pollMs = CURSOR_TRANSCRIPT_POLL_MS) {
    super(home, CURSOR_TRANSCRIPT, onFound, path => inspectTranscriptPath('cursor', path), pollMs)
  }
}

export function findCursorTranscript(home: string, id: string): Promise<string | null> {
  return locateTranscript(CURSOR_TRANSCRIPT, home, id, { valid: path => inspectTranscriptPath('cursor', path) })
}
