import { GROK_TRANSCRIPT } from './contract.js'
import { locateTranscript } from '../kit/sessionLocation.js'

/** Resolve the declared layout, including its hashed-directory fallback for long cwd names. */
export function findGrokTranscript(home: string, cwd: string, id: string): Promise<string | null> {
  return locateTranscript(GROK_TRANSCRIPT, home, id, { cwd })
}
