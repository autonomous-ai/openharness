/**
 * The readers that see a transcript's lines beside its engine's normalizer: the device's delivery
 * evidence (experimental) and the runtime profile (model, effort, mode).
 *
 * Neither may cost a line its events. Live, a throw from either dropped the line before its
 * normalizer saw it, and a turn's end with it, so the agent read as working until its next turn; a
 * catch-up batch lost every line after it; an attach failed. A reader that throws is reported once
 * per session and asked again on the next line.
 */
import { errorKind, sid } from '../../lib/log.js'

export type SideRead = (reader: string, sessionId: string, read: () => void) => void

export function createSideReads(): SideRead {
  const reported = new Set<string>()
  return (reader, sessionId, read) => {
    try {
      read()
    } catch (error) {
      const key = `${reader}\n${sessionId}`
      if (reported.has(key)) return
      reported.add(key)
      // The error's kind only: a reader that parses the line quotes it in its message, and the line is the person's.
      console.error(`[transcripts] the ${reader} could not take in a line of ${sid(sessionId)}; the line goes on to its engine: ${errorKind(error)}`)
    }
  }
}
