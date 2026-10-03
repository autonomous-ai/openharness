import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { MemoryError, type MemoryAccess, type RecallPacket, type RecallRequest } from './types.js'
import type { Arguments, MemoryPort, Operation, Result } from './operations.js'

declare const __MEMORY_WORKER__: string | undefined
interface WorkerOptions { directory: string; profileId: string; source?: string }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** SQLite never executes on harnessd's input/event loop. A timeout never blocks the user's task. */
export class MemoryClient implements MemoryPort {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private readonly ready: Promise<void>
  private state: 'starting' | 'ready' | 'closed' = 'starting'
  private sequence = 0

  constructor(options: WorkerOptions) {
    const require = createRequire(import.meta.url)
    const source = options.source ?? (typeof __MEMORY_WORKER__ === 'string' ? __MEMORY_WORKER__
      : `require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(fileURLToPath(new URL('./worker.ts', import.meta.url)))});`)
    this.worker = new Worker(source, { eval: true, execArgv: [], name: 'harness-memory',
      workerData: { directory: options.directory, profileId: options.profileId }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    this.worker.unref()
    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (): void => { reject(new MemoryError('store_unavailable')); this.fail('store_unavailable') }
      this.worker.on('error', onError)
      this.worker.on('exit', () => { reject(new MemoryError('worker_closed')); this.fail('worker_closed') })
      this.worker.on('message', (message: { type?: string; ok?: boolean; id?: number; reason?: string; value?: unknown }) => {
        if (message.type === 'ready') {
          if (message.ok && this.state === 'starting') { this.state = 'ready'; resolve() }
          else if (!message.ok) { reject(new MemoryError(message.reason ?? 'store_unavailable')); this.fail(message.reason ?? 'store_unavailable') }
          return
        }
        const pending = message.id === undefined ? undefined : this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id!); clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new MemoryError(message.reason ?? 'store_unavailable'))
      })
    })
    // Failure is also observed by the first request. An unused unavailable worker must not reject globally.
    void this.ready.catch(() => {})
  }

  request<K extends Operation>(operation: K, args: Arguments<K>, timeoutMs = 2_000): Promise<Result<K>> {
    if (this.state === 'closed') return Promise.reject(new MemoryError('worker_closed'))
    if (this.pending.size >= 64) return Promise.reject(new MemoryError('memory_busy'))
    const id = ++this.sequence
    return new Promise<Result<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MemoryError('memory_deadline'))
      }, Math.max(1, Math.min(30_000, timeoutMs)))
      this.pending.set(id, { resolve: value => resolve(value as Result<K>), reject, timer })
      void this.ready.then(() => {
        if (!this.pending.has(id)) return
        try { this.worker.postMessage({ id, operation, args }) }
        catch { this.pending.delete(id); clearTimeout(timer); reject(new MemoryError('invalid_input')) }
      }, error => { this.pending.delete(id); clearTimeout(timer); reject(error) })
    })
  }

  async recall(query: RecallRequest, access: MemoryAccess, deadlineMs = 200): Promise<RecallPacket> {
    try { return await this.request('recall', [query, access], deadlineMs) }
    catch (error) {
      return { status: error instanceof MemoryError && error.code === 'memory_deadline' ? 'timeout' : 'unavailable', items: [], text: '', estimatedTokens: 0 }
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.fail('worker_closed')
    // A graceful close processes messages already sent, including a durable capture transaction.
    this.worker.postMessage({ operation: 'close' })
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { void this.worker.terminate().then(() => resolve()); }, 2_000)
      this.worker.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  private fail(reason: string): void {
    this.state = 'closed'
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new MemoryError(reason)) }
    this.pending.clear()
  }
}
