import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from '../secureState.js'
const MAX_BYTES = 32 * 1024 * 1024
/** Atomic local transaction: reservations and immutable results survive together.
 * Never log content. Corrupt/unwritable state fails closed instead of losing dedupe.
 */
export class DeviceResultJournal {
  constructor(private readonly path: string) {}
  load(): unknown {
    secureStateDirectory(dirname(this.path))
    if (!hardenPrivateStateFileIfPresent(this.path, MAX_BYTES)) return undefined
    return JSON.parse(readPrivateStateFile(this.path, MAX_BYTES))
  }
  save(value: unknown): void {
    secureStateDirectory(dirname(this.path))
    hardenPrivateStateFileIfPresent(this.path, MAX_BYTES)
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Device result journal capacity exceeded')
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.path)
      const directory = openSync(dirname(this.path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { rmSync(temporary, { force: true }) }
  }
}
