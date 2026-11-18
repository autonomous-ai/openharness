/** An inherited IPC child; no listener, caller-selected paths, Registry or session lifecycle. */
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sessionStorageFrames } from '../lib/sessionStorageFrames.js'
import { SESSION_STORAGE_REQUEST_MS, SessionStorageUnavailable, sessionImageProof, type SessionStorageOperation } from '../lib/sessionStorageWire.js'
import { createSessionImageCodec, type RetainedSessionImage } from './sessionImage.js'
import { StateFileCleanupUnconfirmed, stateFileCustodyHealthy } from '../lib/secureState.js'
import { createPendingCreationIndex } from './pendingCreations.js'
import { createStoppedList } from './stoppedList.js'

/** Parent owns the original deadline; a child never compares another process's wall clock. */
export function sessionStorageDeadline(remainingMs: unknown): number {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)
    || remainingMs <= 0 || remainingMs > SESSION_STORAGE_REQUEST_MS) throw new SessionStorageUnavailable('expired')
  return performance.now() + remainingMs
}

export function runSessionStorage(): void {
  if (!process.send || !process.connected) throw new Error('Session storage requires its parent link')
  let initialized = false, busy = false
  let frames: ReturnType<typeof sessionStorageFrames> | undefined
  const write = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error('parent disconnected')); return }
    process.send(value, error => error ? reject(error) : resolve())
  })
  const stop = () => { process.exitCode = 2; process.disconnect?.() }
  process.once('disconnect', () => process.exit(0))
  process.on('message', value => {
    if (initialized) { frames?.message(value); return }
    try {
      const init = value as { protocol?: unknown; root?: unknown; stoppedLeaf?: unknown; incarnation?: unknown; retained?: unknown }
      if (init?.protocol !== 'session-storage-init-1' || typeof init.root !== 'string' || !isAbsolute(init.root)
        || typeof init.incarnation !== 'string' || !/^[a-f0-9-]{36}$/.test(init.incarnation)
        || typeof init.stoppedLeaf !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(init.stoppedLeaf)
        || !Array.isArray(init.retained) || init.retained.length > 2) throw new Error()
      const inherited: RetainedSessionImage[] = init.retained.map((value, index) => {
        const source = value as { proof?: unknown; lease?: unknown }
        if (!sessionImageProof(source?.proof) || typeof source.lease !== 'string' || !/^[a-f0-9-]{36}$/.test(source.lease)) throw new Error()
        return { fd: 4 + index, proof: source.proof, lease: source.lease }
      })
      const codec = createSessionImageCodec(init.root, inherited, init.stoppedLeaf)
      const creations = createPendingCreationIndex(join(init.root, 'agent-creations'))
      const stopped = createStoppedList(join(init.root, init.stoppedLeaf), document => codec.read(document))
      initialized = true
      frames = sessionStorageFrames(init.incarnation, write, (id, message) => {
        if (busy) { stop(); return }
        busy = true
        void (async () => {
          const request = message as { remainingMs?: unknown; operation?: SessionStorageOperation }
          try {
            stateFileCustodyHealthy()
            const expires = sessionStorageDeadline(request?.remainingMs)
            const operation = request.operation
            let value: unknown
            switch (operation?.kind) {
              case 'stopped-list-page': value = await stopped.page(operation.cursor, expires); break
              case 'stopped-list-close': stopped.close(operation.cursor); value = null; break
              case 'creation-ensure': creations.ensure(operation.id); value = null; break
              case 'creation-page': value = await creations.page(operation.cursor, expires); break
              case 'creation-close': await creations.close(operation.cursor); value = null; break
              case 'stopped-query': value = await codec.queryStopped(operation.query, expires); break
              case 'read': value = await codec.read(operation.document, operation.retain); break
              case 'equal': value = await codec.equal(operation.proof); break
              case 'prepare': value = await codec.prepare(operation.document, operation.source, operation.value, operation.reservation, operation.rawSource); break
              case 'import': value = codec.import(operation.lease, operation.row, operation.override); break
              case 'release': codec.release(operation.lease); value = null; break
              case 'resolve': value = await codec.resolve(operation.reference); break
              case 'discard': await codec.discard(operation.temporary, operation.identity); value = null; break
              default: throw new SessionStorageUnavailable('invalid')
            }
            if (performance.now() >= expires) throw new SessionStorageUnavailable('expired')
            await frames!.send(id, { ok: true, value })
          } catch (error) {
            const code = error instanceof StateFileCleanupUnconfirmed ? 'cleanup-unconfirmed'
              : error instanceof SessionStorageUnavailable ? error.code : 'unsafe'
            await frames!.send(id, { ok: false, code })
            if (code === 'cleanup-unconfirmed') stop()
          } finally { busy = false }
        })().catch(stop)
      }, stop)
      void write({ protocol: 'session-storage-ready-1', incarnation: init.incarnation }).catch(stop)
    } catch { stop() }
  })
}
