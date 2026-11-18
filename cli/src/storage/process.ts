/** An inherited IPC child; no listener, caller-selected paths, Registry or session lifecycle. */
import { isAbsolute } from 'node:path'
import { sessionStorageFrames } from '../lib/sessionStorageFrames.js'
import { SessionStorageUnavailable, sessionImageProof, type SessionStorageOperation } from '../lib/sessionStorageWire.js'
import { createSessionImageCodec, type RetainedSessionImage } from './sessionImage.js'

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
      initialized = true
      frames = sessionStorageFrames(init.incarnation, write, (id, message) => {
        if (busy) { stop(); return }
        busy = true
        void (async () => {
          const request = message as { expires?: unknown; operation?: SessionStorageOperation }
          try {
            if (typeof request?.expires !== 'number' || !Number.isFinite(request.expires)
              || request.expires <= Date.now()) throw new SessionStorageUnavailable('expired')
            const operation = request.operation
            let value: unknown
            switch (operation?.kind) {
              case 'stopped-query': value = await codec.queryStopped(operation.query, request.expires); break
              case 'read': value = await codec.read(operation.document, operation.retain); break
              case 'equal': value = await codec.equal(operation.proof); break
              case 'prepare': value = await codec.prepare(operation.document, operation.source, operation.value, operation.reservation, operation.rawSource); break
              case 'import': value = codec.import(operation.lease, operation.row, operation.override); break
              case 'release': codec.release(operation.lease); value = null; break
              case 'resolve': value = await codec.resolve(operation.reference); break
              case 'discard': await codec.discard(operation.temporary, operation.identity); value = null; break
              default: throw new SessionStorageUnavailable('invalid')
            }
            await frames!.send(id, { ok: true, value })
          } catch (error) {
            const code = error instanceof SessionStorageUnavailable ? error.code : 'unsafe'
            await frames!.send(id, { ok: false, code })
            if (code === 'cleanup-unconfirmed') stop()
          } finally { busy = false }
        })().catch(stop)
      }, stop)
      void write({ protocol: 'session-storage-ready-1', incarnation: init.incarnation }).catch(stop)
    } catch { stop() }
  })
}
