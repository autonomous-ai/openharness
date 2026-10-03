import { tailFileUntil } from '../../lib/transcriptTail.js'
import type { LastTurnText } from '../../lib/normalize.js'
import { selectCodexRecapLine, lastCodexTurnText } from './normalizer.js'

/** A recap needs the latest turn, not every earlier tool receipt and answer. Keep the existing
 * normalizer authoritative, including goal continuations and both Codex message vocabularies. */
export async function readLastCodexTurnText(filePath: string): Promise<LastTurnText | null> {
  return lastCodexTurnText(await tailFileUntil(filePath, selectCodexRecapLine))
}
