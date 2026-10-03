/** Local, account-scoped opt-in. Reading a choice never creates a store or starts learning. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryError } from './types.js'

export interface MemoryExperimentChoice { enabled: boolean; revision: number }
export class MemoryExperimentSettings {
  private readonly choices = new Map<string, MemoryExperimentChoice>()
  constructor(private readonly directory: string, private readonly legacyDefault = false) {}

  read(owner: string): MemoryExperimentChoice {
    const file = this.file(owner)
    const cached = this.choices.get(owner)
    if (cached) return { ...cached }
    if (!existsSync(file)) return { enabled: this.legacyDefault, revision: 0 }
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new MemoryError('settings_unavailable')
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data.version !== 1 || typeof data.enabled !== 'boolean' || !Number.isSafeInteger(data.revision) || data.revision < 1) throw Error()
      const choice = { enabled: data.enabled, revision: data.revision }
      this.choices.set(owner, choice)
      return { ...choice }
    } catch { throw new MemoryError('settings_unavailable') }
  }

  enabled(owner: string | null): boolean {
    if (!owner) return false
    try { return this.read(owner).enabled } catch { return false }
  }

  write(owner: string, enabled: boolean, expected: number): MemoryExperimentChoice {
    const previous = this.read(owner)
    if (previous.revision !== expected) throw new MemoryError('settings_changed')
    if (previous.enabled === enabled && previous.revision > 0) return previous
    const choice = { enabled, revision: previous.revision + 1 }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file(owner), temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, ...choice }), { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
    } finally { rmSync(temp, { force: true }) }
    this.choices.set(owner, choice)
    return { ...choice }
  }

  private file(owner: string): string {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw new MemoryError('owner_changed')
    return join(this.directory, `${owner}.json`)
  }
}
