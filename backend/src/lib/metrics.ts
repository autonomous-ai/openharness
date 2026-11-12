import http from 'node:http'
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client'
import { createLastHour, type BusyWindow, type DbWindow, type LastHour } from './lastHour.js'
import { logger } from '../utils/logger.js'

/**
 * Prometheus metrics for this process. Node's defaults bring event-loop delay (perf_hooks
 * monitorEventLoopDelay, as nodejs_eventloop_lag_*) and GC pauses (a PerformanceObserver on 'gc', as
 * nodejs_gc_duration_seconds) along with heap, handles and CPU (process_cpu_seconds_total).
 *
 * What the production scan reads (task #2957) is counted here once and goes two ways: cumulative series for a scraper
 * at /metrics, and the one-minute buckets of `last hour` (lib/lastHour.ts), the line the scan reads from a log tail.
 *
 * Labels stay small and bounded: a method, a route PATTERN, a status code, a Prisma model and
 * operation, a kind of work (lib/queryStats.ts workKind). Never a raw URL, a tab, person or machine id —
 * each would be a new series per value. Kinds of work are capped at MAX_WORK, past that `other`.
 */
export function createMetrics(hour: LastHour = createLastHour()) {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Control API request duration, by route pattern and status',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })
  const queryDuration = new Histogram({
    name: 'prisma_query_duration_seconds',
    help: 'Database query duration through Prisma, by model and operation',
    labelNames: ['model', 'operation'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  })
  const dbQueries = new Counter({ name: 'db_queries_total', help: 'Database queries, by kind of work', labelNames: ['work'] as const, registers: [registry] })
  const dbBytes = new Counter({ name: 'db_result_bytes_total', help: 'Database result bytes (JSON characters, sampled and scaled up), by kind of work',
    labelNames: ['work'] as const, registers: [registry] })
  const workBusy = new Counter({ name: 'work_busy_seconds_total', help: 'Main-thread busy time, by kind of work, while CPU_SELF_PROFILE=1',
    labelNames: ['work'] as const, registers: [registry] })
  const phonePushes = new Counter({ name: 'phone_pushes_total', help: 'Pushes to phones (push/send.ts), by platform, outcome and kind',
    labelNames: ['platform', 'outcome', 'kind'] as const, registers: [registry] })
  const githubCommentRecords = new Counter({ name: 'swarm_github_comment_records_total',
    help: 'Records of which agent wrote a GitHub comment (superTabs/githubComments.ts), by outcome', labelNames: ['outcome'] as const, registers: [registry] })
  const githubCommentReads = new Counter({ name: 'swarm_github_comment_ids_total',
    help: 'Comment ids the merger and news asked about (superTabs/githubComments.ts), by whether a record answered', labelNames: ['found'] as const, registers: [registry] })
  const taskTokensWrites = new Counter({ name: 'swarm_task_tokens_writes_total',
    help: 'Writes of what an agent\'s conversation used on a task (superTabs/taskTokens.ts), by outcome', labelNames: ['outcome'] as const, registers: [registry] })
  const taskTokensReads = new Counter({ name: 'swarm_task_tokens_reads_total',
    help: 'Reads of tasks\' tokens (superTabs/taskTokens.ts), by whether a row answered', labelNames: ['found'] as const, registers: [registry] })
  const taskOffers = new Counter({ name: 'swarm_task_offers_total',
    help: 'Offers of a task to an agent and their answers (superTabs/taskOffers.ts), by outcome', labelNames: ['outcome'] as const, registers: [registry] })
  const taskOfferAccept = new Histogram({ name: 'swarm_task_offer_accept_seconds', help: 'From a task\'s offer to its agent\'s daemon accepting it',
    buckets: [1, 2, 5, 10, 20, 30, 60, 90, 120], registers: [registry] })
  const works = new Set<string>()
  const work = (kind: string) => {
    if (works.has(kind)) return kind
    if (works.size >= MAX_WORK - 1) { works.add(OTHER); return OTHER }
    works.add(kind)
    return kind
  }
  return {
    registry, hour,
    /** One Prisma operation's time, from the one query hook (lib/queryStats.ts withQueryStats). */
    observeQuery(model: string, operation: string, seconds: number) { queryDuration.observe({ model, operation }, seconds) },
    /** One HTTP response, by its route pattern (`unrouted` without one), from route latency's hook (lib/routeLatency.ts). */
    request(method: string, route: string, status: number, seconds: number) {
      httpDuration.observe({ method, route, status_code: String(status) }, seconds)
      hour.request(`${method} ${route}`, seconds * 1000, status >= 500)
    },
    /** A minute of `db by shape`, every kind of work's queries and result bytes. */
    dbWindow(window: DbWindow) {
      for (const [kind, w] of window) {
        const labels = { work: work(kind) }
        dbQueries.inc(labels, w.n)
        dbBytes.inc(labels, w.bytes)
      }
      hour.db(window)
    },
    /** One push to one phone: sent, gone (a dead token), sandbox, failed, or unconfigured (no keys for its platform). */
    phonePush(platform: string, outcome: string, kind: string) { phonePushes.inc({ platform, outcome, kind }) },
    /** One record of a GitHub comment's author: recorded, again (the same agent's), taken (another's), limited. */
    githubCommentRecord(outcome: 'recorded' | 'again' | 'taken' | 'limited') { githubCommentRecords.inc({ outcome }) },
    /** One read of comment authors: how many ids it asked about, and how many a record answered. */
    githubCommentRead(asked: number, found: number) {
      githubCommentReads.inc({ found: 'yes' }, found)
      githubCommentReads.inc({ found: 'no' }, asked - found)
    },
    /** One write of a task's tokens: created (a new row), updated (its totals moved on), limited. */
    taskTokensWrite(outcome: 'created' | 'updated' | 'limited') { taskTokensWrites.inc({ outcome }) },
    /** One read of tasks' tokens, and whether any row answered: how many landed changes had their cost to show. */
    taskTokensRead(found: boolean) { taskTokensReads.inc({ found: found ? 'yes' : 'no' }) },
    /** One offer of a task or one answer to it: offered, again (the same one, nothing written), live (refused: another agent's
     *  offer of the task stands, so a PM's daemon that forgot its offers shows here first; counted against no hour), limited (the
     *  PM's hourly offers), declined, late (an answer to an offer that is not this agent's live one). */
    taskOffer(outcome: 'offered' | 'again' | 'live' | 'limited' | 'declined' | 'late') { taskOffers.inc({ outcome }) },
    /** An offer its agent's daemon accepted, [seconds] after it was made: what the two minutes an offer waits rest on. */
    taskOfferAccepted(seconds: number) {
      taskOffers.inc({ outcome: 'accepted' })
      taskOfferAccept.observe(seconds)
    },
    /** A minute of `cpu by kind`, every kind of work's busy ms. */
    busyWindow(window: BusyWindow) {
      for (const [kind, ms] of window) workBusy.inc({ work: work(kind) }, ms / 1000)
      hour.busy(window)
    },
  }
}

export type Metrics = ReturnType<typeof createMetrics>

/** Kinds of work one process labels, `other` included. */
const MAX_WORK = 300
const OTHER = 'other'

/** This process's metrics, served by startMetricsServer. */
export const metrics = createMetrics()

/**
 * Where this worker serves /metrics: always on, with no switch; each pm2 worker binds base + its index (as the mesh
 * port does); loopback unless the deploy says otherwise. Never the public control port.
 */
export function metricsAddress({ portBase = 9464, host = '127.0.0.1' }: { portBase?: number; host?: string }, workerIndex: number) {
  return { port: portBase + workerIndex, host }
}

/** A listener of its own for the scraper: GET /metrics, and 404 for everything else. A failure to bind is logged. */
export function startMetricsServer(registry: Registry, { port, host }: { port: number; host: string }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    registry.metrics().then(
      (text) => { res.writeHead(200, { 'Content-Type': registry.contentType }).end(text) },
      (err) => { logger.error('metrics scrape failed', err); res.writeHead(500).end() },
    )
  })
  // A port already taken must cost the scrape, not the API: unhandled, this 'error' reaches
  // uncaughtException in server.ts, which drains every socket and exits.
  server.on('error', (err) => { logger.error('metrics listener failed', err, { host, port }) })
  server.listen(port, host, () => {
    logger.info(`backend metrics listener on ${host}:${(server.address() as { port: number }).port}`)
  })
  return server
}
