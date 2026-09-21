import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'

export type AgentCreationOutcome =
  | { state: 'created'; agentId: string; level?: 'native' | 'handoff'; resumed?: boolean }
  | { state: 'failed'; error: string; detail?: string; preparedFolder?: string }
  | { state: 'unconfirmed' }

export type AgentCreationStatus = AgentCreationOutcome
  | { state: 'pending' | 'missing' }

type Receipt = {
  version: 1
  fingerprint: string
  outcome: AgentCreationOutcome | { state: 'pending' }
}

export class AgentCreationReceiptError extends Error {
  constructor(readonly code: 'INVALID_CREATION_ID' | 'CREATION_CONFLICT' | 'CREATION_STORAGE_FAILED') {
    super(code)
  }
}

export function validCreationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)
}

/** Only a hash is retained: launch credentials and folder/profile choices do not
 * become a second copy of the launch configuration in the receipt directory. */
export function creationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
      : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/**
 * Reserve an intent before starting its process. A lost reply, reconnect, or
 * daemon restart never turns that same intent into another process launch.
 *
 * Pending receipts survive crashes. If the daemon stopped between starting a
 * process and saving its result, its outcome is unconfirmed; we never guess
 * that nothing started and run the operation again. Receipts are not evicted by
 * age: even an old retry must not silently become a fresh launch.
 */
export class AgentCreationReceipts {
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<AgentCreationStatus> }>()
  // A failed outcome write must not forget an agent we already know was created.
  // The on-disk reservation still prevents a duplicate after a later restart.
  private readonly unsaved = new Map<string, Receipt>()

  constructor(private readonly directory: string) {}

  status(id: string): AgentCreationStatus {
    const receipt = this.read(id)
    if (!receipt) return { state: 'missing' }
    return receipt.outcome.state === 'pending' && !this.inFlight.has(id)
      ? { state: 'unconfirmed' }
      : receipt.outcome
  }

  run(id: string, fingerprint: string, create: () => Promise<AgentCreationOutcome>): Promise<AgentCreationStatus> {
    const running = this.inFlight.get(id)
    if (running) {
      if (running.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return running.result
    }
    const receipt = this.read(id)
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return Promise.resolve(this.status(id))
    }
    // O_EXCL is also the guard against another daemon reaching the same intent.
    // A partial/corrupt reservation is refused, never treated as a missing one.
    try {
      this.write(id, { version: 1, fingerprint, outcome: { state: 'pending' } }, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = this.read(id)
        if (existing?.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
        return Promise.resolve(this.status(id))
      }
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    const result = Promise.resolve().then(async (): Promise<AgentCreationStatus> => {
      let outcome: AgentCreationOutcome
      try { outcome = await create() }
      catch { outcome = { state: 'unconfirmed' } }
      const completed: Receipt = { version: 1, fingerprint, outcome }
      try { this.write(id, completed, false) }
      catch { this.unsaved.set(id, completed) }
      return outcome
    }).finally(() => { this.inFlight.delete(id) })
    this.inFlight.set(id, { fingerprint, result })
    return result
  }

  private file(id: string): string {
    if (!validCreationId(id)) throw new AgentCreationReceiptError('INVALID_CREATION_ID')
    return join(this.directory, `${id}.json`)
  }

  private read(id: string): Receipt | null {
    const file = this.file(id)
    const unsaved = this.unsaved.get(id)
    if (unsaved) return unsaved
    try { secureStateDirectory(this.directory) }
    catch { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }
    try {
      const value = JSON.parse(readPrivateStateFile(file, 16_384)) as Partial<Receipt>
      const outcome = value.outcome
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '') || !outcome ||
          !['pending', 'unconfirmed', 'created', 'failed'].includes(outcome.state) ||
          (outcome.state === 'created' && (typeof outcome.agentId !== 'string' || !outcome.agentId ||
            (outcome.level !== undefined && outcome.level !== 'native' && outcome.level !== 'handoff') ||
            (outcome.resumed !== undefined && typeof outcome.resumed !== 'boolean'))) ||
          (outcome.state === 'failed' && typeof outcome.error !== 'string')) {
        throw new Error('Invalid creation receipt')
      }
      return value as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
  }

  private write(id: string, receipt: Receipt, exclusive: boolean): void {
    const file = this.file(id)
    const writing = exclusive ? file : `${file}.${process.pid}.${randomUUID()}.tmp`
    let opened = false
    try {
      const fd = openSync(writing, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd) }
      finally { closeSync(fd) }
      if (!exclusive) renameSync(writing, file)
      const directoryFd = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } finally {
      // Failed reservations stay on disk so a partial write cannot permit a
      // duplicate. Only this write's private replacement file is disposable.
      if (!exclusive && opened) rmSync(writing, { force: true })
    }
  }
}
