/** Listing owns names and one projected page here; selected row proofs still own every later action. */
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { secureStateDirectory, stateFileCustodyHealthy } from '../lib/secureState.js'
import { SessionStorageUnavailable, SESSION_STORAGE_SYSTEM_FAILURES, STOPPED_LIST_BYTES, STOPPED_LIST_ROWS,
  type SessionDocument, type SessionImage, type StoppedListPage } from '../lib/sessionStorageWire.js'

const token = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export function createStoppedList(directory: string, read: (document: SessionDocument) => Promise<SessionImage>) {
  let scan: { token: string; names: string[]; next: number; held?: { image: SessionImage; bytes: number } } | undefined
  const close = (cursor: string): void => {
    if (!token(cursor)) throw new SessionStorageUnavailable('invalid')
    if (scan?.token === cursor) scan = undefined
  }
  const page = async (cursor: string | null, deadline: number): Promise<StoppedListPage> => {
    stateFileCustodyHealthy()
    if (cursor !== null && !token(cursor)) throw new SessionStorageUnavailable('invalid')
    const check = () => { if (performance.now() >= deadline) throw new SessionStorageUnavailable('expired') }
    check()
    if (cursor === null) {
      if (scan) throw new SessionStorageUnavailable('busy')
      try {
        secureStateDirectory(directory, false)
        scan = { token: randomUUID(), names: (await readdir(directory)).filter(name => name.endsWith('.json')), next: 0 }
      } catch (error) {
        if (missing(error)) return { cursor: '', offset: 0, next: 0, total: 0, images: [], done: true }
        throw error
      }
    } else if (scan?.token !== cursor) throw new SessionStorageUnavailable('changed')
    const own = scan!, images: SessionImage[] = [], offset = own.next
    let bytes = 0
    try {
      while (own.next < own.names.length && own.next - offset < STOPPED_LIST_ROWS) {
        check()
        if (!own.held) {
          const agentId = own.names[own.next].slice(0, -5)
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) { own.next++; continue }
          try {
            const image = await read({ kind: 'stopped', agentId })
            check()
            if (image.state === 'missing') { own.next++; continue }
            own.held = { image, bytes: Buffer.byteLength(JSON.stringify(image)) }
          } catch (error) {
            if (!(error instanceof SessionStorageUnavailable) || ![...SESSION_STORAGE_SYSTEM_FAILURES, 'unsafe', 'invalid', 'missing', 'changed'].includes(error.code)) throw error
            own.next++; continue
          }
        }
        if (images.length && bytes + own.held.bytes > STOPPED_LIST_BYTES) break
        images.push(own.held.image)
        bytes += own.held.bytes
        own.held = undefined
        own.next++
        if (bytes >= STOPPED_LIST_BYTES) break
      }
      check()
      const done = own.next === own.names.length
      if (done) scan = undefined
      return { cursor: own.token, offset, next: own.next, total: own.names.length, images, done }
    } catch (error) { scan = undefined; throw error }
  }
  return { page, close }
}
