/** A Store crash must not turn an uncertain workspace init into another execution. */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { creationFingerprint } from '../lib/agentCreationReceipt.js'
import { readPrivateStateFile, secureStateDirectory } from '../lib/secureState.js'

export class DshPreparationUnavailable extends Error {}
export type PrepareDsh = <T>(workspace: string, input: unknown, run: () => Promise<T>, replay?: boolean) => Promise<T>

/** The resource is the canonical workspace, independent of package, engine, agent and retry label.
 * Reservations never expire. An init can outlive a killed Store and can have arbitrary external effects:
 * only a confirmed outcome permits another operation, never the age or liveness of the Store process.
 * These files belong to the daemon, outside the workspace; user files are never rolled back or deleted.
 */
export function dshPreparations(directory: string): PrepareDsh {
  const active = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  const uncertain = () => new DshPreparationUnavailable(
    'Previous workspace preparation is unconfirmed. This harness is held for review so its initialization is not run twice.')
  const write = (file: string, value: unknown, exclusive = false): void => {
    const temp = exclusive ? file : `${file}.${randomUUID()}.tmp`
    let opened = false
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
      if (!exclusive) renameSync(temp, file)
      const dir = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
    } finally {
      if (!exclusive && opened) rmSync(temp, { force: true })
    }
  }
  return async <T>(workspace: string, input: unknown, run: () => Promise<T>, replay = false): Promise<T> => {
    let resource: string
    let incarnation: string
    try {
      resource = creationFingerprint(realpathSync(workspace))
      const stat = statSync(workspace, { bigint: true })
      incarnation = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
      secureStateDirectory(directory)
    }
    catch { throw new DshPreparationUnavailable('The Store cannot safely record workspace preparation. This harness is held until its preparation records are accessible.') }
    const fingerprint = creationFingerprint({ input, incarnation })
    const running = active.get(resource)
    if (running) {
      if (running.fingerprint === fingerprint) return running.result as Promise<T>
      throw new DshPreparationUnavailable('Another preparation is still running in this workspace. This harness waits for it to finish.')
    }
    const reservation = join(directory, `${resource}.pending`)
    const receipt = join(directory, `${resource}-${fingerprint}.json`)
    try { write(reservation, { version: 1, fingerprint, state: 'pending' }, true) }
    catch { throw uncertain() }
    const release = () => {
      rmSync(reservation)
      const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
    }
    // Only workspace initialization reuses an outcome. Runtime preparation revalidates its current files
    // and account on every launch, even if the package/runtime key did not change.
    if (replay) {
      try {
        const saved = JSON.parse(readPrivateStateFile(receipt, 1024 * 1024))
        if (saved.fingerprint !== fingerprint || saved.state !== 'complete') throw uncertain()
        release()
        return saved.answer as T
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw uncertain() }
    }
    const result = Promise.resolve().then(async () => {
      let answer: T
      try { answer = await run() }
      catch { throw uncertain() }
      // Persist the outcome before releasing the resource. If either write is uncertain, preserve the
      // reservation: a new process must not infer that a stopped writer made no workspace changes.
      try {
        write(receipt, { version: 1, fingerprint, state: 'complete', answer })
        release()
      } catch { throw uncertain() }
      return answer
    }).finally(() => active.delete(resource))
    active.set(resource, { fingerprint, result })
    return result
  }
}
