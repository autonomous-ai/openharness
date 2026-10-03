import { parentPort, workerData } from 'node:worker_threads'
import { CodingMemoryStore } from './store.js'
import { MemoryError } from './types.js'
import { QUEUE_OPERATIONS, STORE_OPERATIONS } from './operations.js'

if (!parentPort) throw new Error('memory worker requires a parent port')
const port = parentPort
const opened = CodingMemoryStore.open(workerData as { directory: string; profileId: string })
if (!opened.ok) { port.postMessage({ type: 'ready', ok: false, reason: opened.reason }); port.close() }
else {
  const store = opened.store
  const operations = new Map<string, (...args: never[]) => unknown>()
  for (const name of STORE_OPERATIONS) operations.set(name, store[name].bind(store) as (...args: never[]) => unknown)
  for (const name of QUEUE_OPERATIONS) operations.set(name, store.learning[name].bind(store.learning) as (...args: never[]) => unknown)
  port.on('message', (message: { id?: number; operation?: string; args?: unknown[] }) => {
    if (message?.operation === 'close') { store.close(); port.close(); return }
    if (!Number.isSafeInteger(message?.id) || !Array.isArray(message?.args)) return
    const operation = operations.get(message.operation ?? '')
    try {
      if (!operation) throw new MemoryError('unknown_operation')
      port.postMessage({ type: 'result', id: message.id, ok: true, value: operation(...message.args as never[]) })
    } catch (error) {
      port.postMessage({ type: 'result', id: message.id, ok: false, reason: error instanceof MemoryError ? error.code : 'store_unavailable' })
    }
  })
  port.postMessage({ type: 'ready', ok: true })
}
