import type { LastTurnText } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { tailFileCapped } from '../../lib/transcriptTail.js'

/**
 * The last turn of an engine with no reader from the end: read from the newest part of its transcript,
 * bounded like every whole read of an engine without pages (lib/transcriptTail.ts). The last turn is at
 * the end, and a transcript past the cap would otherwise be read whole at every turn's end.
 *
 * Still a whole read up to the cap, once per turn end, for these engines: bounding them further is engine
 * work still to come (docs/research/2026-10-04-whole-history-reads.md).
 */
export async function lastTurnFromTail(
  session: Pick<RegisteredSession, 'transcriptPath'>,
  lastTurn: (lines: string[]) => LastTurnText | null,
): Promise<LastTurnText | null> {
  if (!session.transcriptPath) return null
  const { lines } = await tailFileCapped(session.transcriptPath)
  return lastTurn(lines)
}
