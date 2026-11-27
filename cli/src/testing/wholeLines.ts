import { readFileSync } from 'node:fs'

/** The lines a fake has finished writing to [file], the log it appends one line a call to. A spec may read it while a call
 *  still runs: the append creates the file before it writes, and a line without its newline is still being written.
 *  Parsed, half a line threw in a spec under load (agentBrowser.spec.ts, 2026-11-19). */
export function wholeLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').slice(0, -1)
}
