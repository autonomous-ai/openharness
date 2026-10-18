import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RosterHarness } from './roster.js'
import { list, NO, num, object, oneOf, text } from './shape.js'

/**
 * Requests a member made that the owner's computer has not applied yet, kept on disk so a restart of the messages
 * process does not drop them (spec: nothing is dropped silently). Resending is safe: the owner applies a request
 * once and answers a repeat with the roster it already published.
 */
export type QueuedRequest = { sharedTabId: string; op: 'add' | 'remove'; harness: RosterHarness; since: number }
const harness = object<RosterHarness>({ accountId: text(), machineId: text(), machinePublicKey: text(), agentId: text(), name: text(), engine: text() })
const entries = list(object<QueuedRequest>({ sharedTabId: text(Infinity, 0, /^[a-f0-9]{24}$/), op: oneOf('add', 'remove'), harness, since: num }))

export class RequestStore {
  constructor(private readonly path: string, private readonly now = () => Date.now()) {}

  /** The waiting requests: none when there is no file yet. A file that reads but holds no list is moved aside. Any other
   *  error reading it (EACCES, EMFILE, EIO) is thrown: the file may be whole, and an empty queue in its place would be
   *  written over it at the next change, losing a waiting remove with no trace (review of A7). */
  load(): QueuedRequest[] {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let json: unknown = null
    try { json = JSON.parse(raw) } catch { /* unreadable below */ }
    const parsed = entries(json)
    if (parsed !== NO) return parsed
    // Unreadable: keep it for a person to look at, and start again rather than refuse every request.
    try { renameSync(this.path, `${this.path}.unreadable-${this.now()}`) } catch { /* nothing more to do */ }
    return []
  }

  save(list: QueuedRequest[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(list), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
  }
}
