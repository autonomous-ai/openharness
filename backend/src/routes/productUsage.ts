import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ingestProductUsage, ingestSetupUsage, productUsageChoice, setProductUsageChoice } from '../lib/productUsage.js'
import { PRODUCT_FEEDBACK, PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS, PRODUCT_USAGE_SETUP_METRICS } from '../types/productUsage.js'
import { releaseBucket } from '../types/productHealthContract.js'
import { sendError, sendSuccess } from '../utils/response.js'

const contextSchema = z.strictObject({
  surface: z.enum(['cli', 'desktop', 'phone']),
  release: z.string().max(11).refine(v => v === 'unknown' || releaseBucket(v) === v),
  platform: z.enum(['macos', 'linux', 'windows', 'ios', 'android', 'other']),
  channel: z.enum(['production', 'development']),
})

export const productUsageReportSchema = z.strictObject({
  context: contextSchema.optional(),
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), id: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.partialRecord(z.enum(PRODUCT_USAGE_METRICS), z.number().int().min(0).max(PRODUCT_USAGE_MAX_COUNT)),
})
const feedbackSchema = z.strictObject({ id: z.uuid(), answer: z.enum(PRODUCT_FEEDBACK) })
const choiceSchema = z.strictObject({ enabled: z.boolean() })
const setupFields = {
  schemaVersion: z.literal(1), id: z.uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counters: z.partialRecord(z.enum(PRODUCT_USAGE_SETUP_METRICS), z.number().int().min(1).max(1000))
    .refine(c => Object.keys(c).length > 0 && Object.keys(c).length <= 32),
}
// The surfaces whose signed-out counts may be on by default, each report wholly one surface's.
const DEFAULT_SETUP_PREFIXES = ['setup_desktop_', 'setup_phone_']
export const setupUsageSchema = z.union([
  // Older native clients (earlier phone builds included) still require explicit opt-in.
  z.strictObject({ ...setupFields, consent: z.literal(true) }),
  // Desktop and the phone default on, with an opt-out each keeps (Desktop's Settings, the line under
  // the phone's signed-out screens). Do not call that consent.
  z.strictObject({ ...setupFields, sharing: z.literal('default') })
    .refine(report => DEFAULT_SETUP_PREFIXES.some(prefix =>
      Object.keys(report.counters).every(key => key.startsWith(prefix)))),
])

const REPORT_METRICS = new Set<string>(PRODUCT_USAGE_METRICS)
const SETUP_METRICS = new Set<string>(PRODUCT_USAGE_SETUP_METRICS)
/** A client a release ahead of this backend can name a counter the contract here does not have yet.
 * Rejecting the whole report for it lost every other counter in it — up to 64 per CLI report — and the
 * client retried the same rejected report for days. Keep the known counters, drop the unknown names
 * (never stored or echoed) and say how many reports that happened to. A report with no known counter
 * left is still refused. Values and every other field are validated as before. */
function withoutUnknownCounters(body: unknown, allowed: Set<string>): { body: unknown; dropped: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, dropped: false }
  const counters = (body as { counters?: unknown }).counters
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) return { body, dropped: false }
  const all = Object.entries(counters)
  const known = all.filter(([metric]) => allowed.has(metric))
  if (!known.length || known.length === all.length) return { body, dropped: false }
  return { body: { ...body, counters: Object.fromEntries(known) }, dropped: true }
}

export async function productUsageRoutes(app: FastifyInstance): Promise<void> {
  // A process-wide budget bounds untrusted pre-sign-in counts without collecting IPs or cookies.
  // Exhaustion loses measurement only; it never shares a gate with sign-in or product traffic.
  let setupWindow = 0, setupRequests = 0, setupInFlight = 0
  // Parser errors can contain a piece of malformed JSON. Keep this plugin's errors out of the
  // generic logger/response handler, including failures before the route's schema check runs.
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { statusCode?: number } | null)?.statusCode
    const status = code && code >= 400 && code < 500 ? code : 503
    return sendError(reply, 'Product usage request unavailable', 'USAGE_UNAVAILABLE', status)
  })
  app.post('/api/product-usage/setup', { bodyLimit: 4096 }, async (req, reply) => {
    if (req.headers.authorization || req.headers.cookie) return sendError(reply, 'Setup reports must omit credentials', 'INVALID_SETUP_REPORT', 400)
    const parsed = setupUsageSchema.safeParse(withoutUnknownCounters(req.body, SETUP_METRICS).body)
    if (!parsed.success) return sendError(reply, 'Invalid setup report', 'INVALID_SETUP_REPORT', 400)
    const minute = Math.floor(Date.now() / 60_000)
    if (minute !== setupWindow) { setupWindow = minute; setupRequests = 0 }
    if (setupRequests >= 120 || setupInFlight >= 4) return sendError(reply, 'Setup measurement busy', 'USAGE_UNAVAILABLE', 429)
    setupRequests++; setupInFlight++
    try { return sendSuccess(reply, await ingestSetupUsage(parsed.data)) }
    catch { return sendError(reply, 'Setup measurement unavailable', 'USAGE_UNAVAILABLE', 503) }
    finally { setupInFlight-- }
  })
  app.get('/api/product-usage/settings', async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    return sendSuccess(reply, await productUsageChoice(req.user.sub))
  })
  app.post('/api/product-usage/settings', { bodyLimit: 128 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = choiceSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid usage preference', 'INVALID_USAGE_PREFERENCE', 400)
    return sendSuccess(reply, await setProductUsageChoice(req.user.sub, parsed.data.enabled))
  })
  app.post('/api/product-usage/feedback', { bodyLimit: 256 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const parsed = feedbackSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid feedback', 'INVALID_FEEDBACK', 400)
    const choice = await productUsageChoice(req.user.sub)
    if (!choice.enabled) return sendError(reply, 'Product usage sharing is off', 'SHARING_DISABLED', 409)
    const result = await ingestProductUsage(req.user.sub, { schemaVersion: 1, revision: choice.revision,
      id: parsed.data.id, day: new Date().toISOString().slice(0, 10), counters: { [`feedback_${parsed.data.answer}`]: 1 } })
    return sendSuccess(reply, result)
  })
  app.post('/api/product-usage/report', { bodyLimit: 8192 }, async (req, reply) => {
    if (!req.user?.sub) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const cleaned = withoutUnknownCounters(req.body, REPORT_METRICS)
    const parsed = productUsageReportSchema.safeParse(cleaned.body)
    // Never reflect rejected fields, values or raw validation errors into logs or responses.
    if (!parsed.success) return sendError(reply, 'Invalid usage report', 'INVALID_USAGE_REPORT', 400)
    if (cleaned.dropped && parsed.data.context) {
      parsed.data.counters[`health_${parsed.data.context.surface}_report_unknown_metric`] = 1
    }
    try { return sendSuccess(reply, await ingestProductUsage(req.user.sub, parsed.data)) }
    catch (error) {
      // A fixed category can diagnose delivery without exposing database errors or report contents.
      const storageCode = (error as { code?: unknown } | null)?.code
      if (storageCode === 'USAGE_BUSY') return sendError(reply, 'Usage measurement busy', 'USAGE_BUSY', 429)
      const code = storageCode === 'P2034' || storageCode === 'P2002' ? 'USAGE_WRITE_CONFLICT'
        : storageCode === 'P2028' ? 'USAGE_TRANSACTION_FAILED' : 'USAGE_UNAVAILABLE'
      return sendError(reply, 'Usage report unavailable', code, 503)
    }
  })
}
