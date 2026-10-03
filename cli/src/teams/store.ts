import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { readPrivateStateFile, secureStateDirectory } from '../lib/secureState.js'
import { TeamError } from './model.js'

/** Atomic private records; corrupt files are never silently replaced. */
export class TeamStore<T> {
  constructor(private readonly directory: string, private readonly schema: z.ZodType<T>) {}
  ids(): string[] {
    secureStateDirectory(this.directory)
    return readdirSync(this.directory).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(n => n.slice(0, -5))
  }
  read(id: string): T | null {
    const path = this.path(id)
    if (!existsSync(path)) return null
    try { return this.schema.parse(JSON.parse(readPrivateStateFile(path, 16 * 1024 * 1024))) }
    catch { throw new TeamError('CORRUPT_STATE', 'This team record could not be read. Its file has been preserved for recovery.') }
  }
  write(id: string, value: T): void {
    const path = this.path(id)
    const content = JSON.stringify(this.schema.parse(value))
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new TeamError('TEAM_FULL', 'The team history is full. Archive this team and create another.')
    secureStateDirectory(this.directory)
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path)
      if (process.platform !== 'win32') {
        const directoryFd = openSync(this.directory, 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
    } finally {
      try { unlinkSync(temporary) } catch { /* moved, or never created */ }
    }
  }
  private path(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new TeamError('INVALID_ID', 'Invalid team record identity.')
    return join(this.directory, `${id}.json`)
  }
}
