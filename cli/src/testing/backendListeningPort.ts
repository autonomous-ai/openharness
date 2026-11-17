import { readFileSync } from 'node:fs'

/** The port of the backend's `backend listening on <n>` line in its log (backend/src/server.ts), or null before it
 *  said one. The end-to-end harness and the stack scripts (cli/scripts/) both read the backend's port with it. The
 *  newline is part of the match because the log is read while it is written: a line caught in the middle of its port
 *  would read as a shorter one. */
export function backendListeningPort(log: string): number | null {
  const line = / backend listening on (\d+)\n/.exec(log)
  return line ? Number(line[1]) : null
}

/** backendListeningPort of the log file at `logPath`; null too while the file is not there yet, as when a script reads
 *  it as its backend starts. */
export function backendListeningPortIn(logPath: string): number | null {
  try {
    return backendListeningPort(readFileSync(logPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
