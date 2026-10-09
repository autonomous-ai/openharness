/** Grok's transcript layout, including the sidecar used when the encoded cwd would be too long. */
import type { TranscriptLocation } from '../kit/sessionLocation.js'

export const GROK_TRANSCRIPT: TranscriptLocation = {
  id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  kind: 'cwd', root: 'sessions', file: 'updates.jsonl', sidecar: '.cwd',
}
