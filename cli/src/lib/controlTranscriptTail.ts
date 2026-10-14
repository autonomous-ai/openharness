import { stat } from 'node:fs/promises'
import { isWholeRecord } from './attachTranscript.js'
import { closeFileIdentity, verifyCloses, type TranscriptClose } from './transcriptControls.js'
import { scanRecordsBackward, streamRecords } from './transcriptTail.js'

/** A bounded native-file recovery fold with exact byte positions. The newest
 * cancellation and every later record must fit; otherwise interpretation stays
 * held. Earlier history may be omitted, since that cancellation closes it. */
export async function controlTranscriptTail(file: string, closes: readonly TranscriptClose[], maxBytes: number, requireTerminator = false) {
  verifyCloses(file, closes)
  const identity = closeFileIdentity(closes)
  if (!identity) throw new Error('the transcript control file identity is unavailable')
  const end = (await stat(file)).size, floor = Math.max(0, end - maxBytes)
  const last = closes.at(-1)!
  if (last.offset < floor) throw new Error('the transcript since cancellation exceeds the recovery read limit')
  let start = end
  if (!await scanRecordsBackward(file, end, (_record, offset) => { start = offset },
    maxBytes, undefined, identity, floor)) throw new Error('ENGINE_CONTROL_BOUNDARY_CHANGED')
  // Always include the whole suffix after Cancel, even if its first record is
  // unfinished. No bytes in that suffix may be mistaken for omitted history.
  // Blank records are filtered by the scanner. Covering byte zero still proves
  // a complete prefix, even when the first nonblank record starts later.
  start = floor === 0 ? 0 : Math.min(start, last.offset)
  const lines: string[] = [], offsets: number[] = []
  const read = await streamRecords(file, start, end, (line, offset) => { lines.push(line); offsets.push(offset) },
    requireTerminator ? () => false : isWholeRecord, maxBytes, identity)
  if (!read) throw new Error('ENGINE_CONTROL_BOUNDARY_CHANGED')
  verifyCloses(file, closes)
  return { lines, offsets, identity, start, next: read.next, truncated: start > 0 }
}
