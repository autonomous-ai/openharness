/** Bounded feature-state observations, made only by the edge host. No saved content leaves it. */
import { errorKind } from '../lib/log.js'
import * as fs from 'node:fs'

const SAVED_BYTES = 1024 * 1024
const DIRECTORY_ENTRIES = 4096
const READ_CALLS = 32
export interface StartupFiles {
  exists(path: string): boolean
  matches(path: string, prefix: string, suffix: string): boolean
  rows(path: string): unknown[]
}
type Io = Pick<typeof fs, 'openSync' | 'fstatSync' | 'readSync' | 'closeSync' | 'statSync' | 'opendirSync'>
const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

export function createStartupFiles(log: (line: string) => void, io: Io = fs): StartupFiles {
  const failed = (error: unknown): void => { if (!absent(error)) log('[startup] STARTUP_STATE_UNAVAILABLE') }
  return {
    exists(path) {
      try { io.statSync(path); return true } catch (error) { failed(error); return false }
    },
    matches(path, prefix, suffix) {
      let directory: fs.Dir | undefined
      try {
        directory = io.opendirSync(path, { bufferSize: 32 })
        for (let count = 0; count < DIRECTORY_ENTRIES; count++) {
          const entry = directory.readSync()
          if (!entry) return false
          if (entry.name.startsWith(prefix) && entry.name.endsWith(suffix)) return true
        }
        // The feature can inspect its own larger store. A bounded preflight must never declare it absent.
        log('[startup] STARTUP_SCAN_LIMIT')
        return true
      } catch (error) { failed(error); return false }
      finally { try { directory?.closeSync() } catch (caughtFailure) { log(('[startup] STARTUP_STATE_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)) } }
    },
    rows(path) {
      let fd: number | undefined
      try {
        fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
        if (!io.fstatSync(fd).isFile()) { log('[startup] STARTUP_STATE_UNAVAILABLE'); return [] }
        const bytes = Buffer.allocUnsafe(SAVED_BYTES + 1)
        let size = 0
        for (let count = 0; count < READ_CALLS; count++) {
          const read = io.readSync(fd, bytes, size, bytes.length - size, null)
          size += read
          if (size > SAVED_BYTES) { log('[startup] STARTUP_STATE_TOO_LARGE'); return [] }
          if (read !== 0) continue
          const value: unknown = JSON.parse(bytes.toString('utf8', 0, size))
          return Array.isArray(value) ? value : []
        }
        log('[startup] STARTUP_STATE_READ_LIMIT')
        return []
      } catch (error) {
        if (error instanceof SyntaxError) log('[startup] STARTUP_STATE_INVALID')
        else failed(error)
        return []
      } finally { try { if (fd !== undefined) io.closeSync(fd) } catch (caughtFailure) { log(('[startup] STARTUP_STATE_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)) } }
    },
  }
}
