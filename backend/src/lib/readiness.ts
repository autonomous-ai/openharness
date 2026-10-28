/**
 * Readiness: whether this process should receive new traffic. Liveness (`/api/health`) only says the process is
 * alive and never touches a dependency, so a Mongo or Redis outage cannot make the orchestrator restart every pod.
 * Readiness (`/api/ready`) pings them, so a pod is not sent traffic before it can serve it, and answers "draining"
 * from the moment a shutdown signal lands, so it is taken out of rotation before its listeners close.
 */

export type DependencyCheck = () => unknown
export type CheckResult = 'ok' | 'failed' | 'timeout'
export interface ReadinessReport { ready: boolean; draining: boolean; checks: Record<string, CheckResult> }

export interface Drain {
  readonly draining: boolean
  start(): void
}

export function createDrain(): Drain {
  let draining = false
  return {
    get draining() { return draining },
    start() { draining = true },
  }
}

/** This process' drain. Under pm2 each cluster worker is its own process and gets its own signal, so each marks only
 *  itself. Shutdown starts it first (server.ts); anything that must stop taking work while draining reads it. */
export const processDrain = createDrain()

/** Mark draining, then keep serving for `delayMs` so the load balancer sees readiness fail and stops sending new
 *  connections before the listeners close. */
export async function drainBeforeClosing(drain: Drain, delayMs: number): Promise<void> {
  drain.start()
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
}

/** The backend's dependencies. Redis only where one is configured: local and self-hosted backends may run without. */
export function backendReadinessChecks(
  environment: Record<string, string | undefined>,
  deps: { mongo: DependencyCheck; redis: DependencyCheck },
): Record<string, DependencyCheck> {
  return environment.REDIS_URL ? { mongo: deps.mongo, redis: deps.redis } : { mongo: deps.mongo }
}

async function run(check: DependencyCheck, timeoutMs: number): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<CheckResult>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  try {
    // A check that throws before returning a promise is a failure too, not a crashed probe.
    const answered = (async (): Promise<CheckResult> => { await check(); return 'ok' })().catch((): CheckResult => 'failed')
    return await Promise.race([answered, timeout])
  } finally { clearTimeout(timer) }
}

const DRAINING: ReadinessReport = { ready: false, draining: true, checks: {} }

/**
 * One ping per dependency at most every `cacheMs`, however often the probes come: probes that arrive while a ping
 * is running, or within `cacheMs` of its start, share its answer. Error text never leaves here: a failed check is
 * only named, since a driver's message can carry a connection string.
 */
export function createReadiness(
  checks: Record<string, DependencyCheck>,
  { timeoutMs = 1_000, cacheMs = 1_000, drain = processDrain }: { timeoutMs?: number; cacheMs?: number; drain?: Drain } = {},
): { probe(): Promise<ReadinessReport> } {
  let last: { startedAt: number; settled: boolean; report: Promise<ReadinessReport> } | null = null

  const ping = async (): Promise<ReadinessReport> => {
    const names = Object.keys(checks)
    const results = await Promise.all(names.map((name) => run(checks[name], timeoutMs)))
    const report: ReadinessReport['checks'] = {}
    names.forEach((name, i) => { report[name] = results[i] })
    return { ready: results.every((r) => r === 'ok'), draining: false, checks: report }
  }

  return {
    async probe() {
      if (drain.draining) return DRAINING
      const now = Date.now()
      if (!last || (last.settled && now - last.startedAt >= cacheMs)) {
        const entry = { startedAt: now, settled: false, report: ping() }
        void entry.report.finally(() => { entry.settled = true })
        last = entry
      }
      const report = await last.report
      // A drain that began while the ping ran wins over its answer.
      return drain.draining ? DRAINING : report
    },
  }
}
