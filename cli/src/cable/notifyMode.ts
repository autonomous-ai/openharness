// The Notifications setting: whether an ordinary finished turn still beeps the dial (All) or only lists
// (Needs you). It is this computer's, not the dial's, so it lives in the daemon's data folder and outlives the
// devices' process, which restarts often. One writer: the devices' process.
import { closeSync, openSync, readSync } from 'node:fs'
import { atomicWriteFile } from '../lib/secureState.js'

export type NotifyMode = 'full' | 'you'

export const isNotifyMode = (value: unknown): value is NotifyMode => value === 'full' || value === 'you'

export const NOTIFY_MODE_FILE = 'dial-notify.json'

/** The file holds one short object; anything larger is not ours, and reading it whole would cost the start. */
const MAX_BYTES = 1024

const readMode = (file: string): NotifyMode => {
  try {
    const fd = openSync(file, 'r')
    try {
      // One byte past the limit tells a file at the limit from a longer one.
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      const length = readSync(fd, buffer, 0, buffer.length, 0)
      if (length > MAX_BYTES) return 'full'
      const mode = (JSON.parse(buffer.toString('utf8', 0, length)) as { mode?: unknown } | null)?.mode
      return isNotifyMode(mode) ? mode : 'full'
    } finally {
      closeSync(fd)
    }
  } catch {
    // Missing or unreadable reads as the default, and the next change writes a good file.
    return 'full'
  }
}

export class NotifyModeStore {
  private mode: NotifyMode

  constructor(private readonly file: string) {
    this.mode = readMode(file)
  }

  get(): NotifyMode {
    return this.mode
  }

  /** The error's code (EACCES, EISDIR) when the file could not be written, and the mode in force stays; undefined
   *  once it is saved. The same mode again writes nothing. The code is for the log: never the error's message, which
   *  names the path. */
  set(mode: NotifyMode): string | undefined {
    if (mode === this.mode) return undefined
    try {
      atomicWriteFile(this.file, `${JSON.stringify({ mode })}\n`, 'cache')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code ?? 'FAILED'
    }
    this.mode = mode
    return undefined
  }
}
