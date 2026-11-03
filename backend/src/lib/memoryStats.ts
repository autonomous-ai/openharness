/**
 * The process's memory, every minute (`memory`): what the HPA's memory metric sees from inside. On v1.3.87 (2026-11-03) pods
 * held ~750 MB each and a 70% memory target took the backend from 2 to 6 pods at 22% CPU, with nothing in the logs to say
 * what held it. The Swarm read cache's own count (its values' JSON size, cache.ts freeze) sits beside the heap, so the two
 * can be compared.
 */
import { logger } from '../utils/logger.js'

const MB = 1024 * 1024
const mb = (bytes: number) => Math.round(bytes / MB)

type Usage = Pick<NodeJS.MemoryUsage, 'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers'>

export function startMemoryStats({ everyMs = 60_000, log = (message: string, context: Record<string, unknown>) => logger.info(message, context),
  usage = () => process.memoryUsage(), cache }: {
  everyMs?: number
  log?: (message: string, context: Record<string, unknown>) => void
  usage?: () => Usage
  /** What the read cache holds now, or null when the process has none. */
  cache: () => { entries: number; bytes: number } | null
}): () => void {
  const timer = setInterval(() => {
    const now = usage(), held = cache()
    log('memory', { rssMb: mb(now.rss), heapTotalMb: mb(now.heapTotal), heapUsedMb: mb(now.heapUsed), externalMb: mb(now.external),
      arrayBuffersMb: mb(now.arrayBuffers), ...held ? { cache: { entries: held.entries, mb: mb(held.bytes) } } : {} })
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
