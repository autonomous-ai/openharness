import Fastify, { type FastifyRequest } from 'fastify'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const methods = vi.hoisted(() => ({ ingestProductUsage: vi.fn(), ingestSetupUsage: vi.fn(), productUsageChoice: vi.fn(), setProductUsageChoice: vi.fn() }))
vi.mock('../lib/productUsage.js', () => methods)
import { productUsageRoutes } from './productUsage.js'
import { PRODUCT_USAGE_METRICS, PRODUCT_USAGE_MAX_COUNT } from '../types/productUsage.js'
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.resetAllMocks()
  app = Fastify({ logger: false })
  app.addHook('onRequest', async (req: FastifyRequest) => { if (req.headers.authorization === 'fixture') req.user = { sub: 'account' } as typeof req.user })
  await app.register(productUsageRoutes)
  methods.productUsageChoice.mockResolvedValue({ enabled: true, revision: 0 })
  methods.ingestProductUsage.mockResolvedValue({ accepted: true })
  methods.ingestSetupUsage.mockResolvedValue({ accepted: true })
})
afterEach(() => app.close())
const good = { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-13', counters: { turns_started: 1 } }
const submit = (payload: unknown) => app.inject({ method: 'POST', url: '/api/product-usage/report', headers: { authorization: 'fixture' }, payload: payload as Record<string, unknown> })
it('requires a signed-in account and does not let the report choose its identity', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/product-usage/report', payload: good })).statusCode).toBe(401)
  expect((await submit(good)).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledWith('account', good)
})
it.each([
  { ...good, prompt: 'PRIVATE_CANARY' }, { ...good, userId: 'PRIVATE_CANARY' },
  { ...good, counters: { 'PRIVATE_CANARY': 1 } }, { ...good, counters: { turns_started: 'PRIVATE_CANARY' } },
  { ...good, counters: { turns_started: -1 } }, { ...good, counters: { turns_started: 100001 } },
  { ...good, counters: { turns_started: 1.5 } }, { ...good, id: 'PRIVATE_CANARY' },
])('refuses unknown fields and malformed values without echoing them', async payload => {
  const response = await submit(payload)
  expect(response.statusCode).toBe(400)
  expect(response.body).not.toContain('PRIVATE_CANARY')
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
})
it('keeps a report with a name this backend does not know yet, without that name', async () => {
  const context = { surface: 'cli', release: '0.4.18', platform: 'macos', channel: 'production' }
  const response = await submit({ ...good, context, counters: { turns_started: 2, PRIVATE_CANARY_from_a_newer_client: 1 } })
  expect(response.statusCode).toBe(200)
  expect(response.body).not.toContain('PRIVATE_CANARY')
  expect(methods.ingestProductUsage).toHaveBeenCalledExactlyOnceWith('account',
    { ...good, context, counters: { turns_started: 2, health_cli_report_unknown_metric: 1 } })
})
it('keeps a setup report with a name this backend does not know yet, without that name', async () => {
  const setup = { schemaVersion: 1, id: good.id, day: good.day, sharing: 'default',
    counters: { setup_desktop_sign_in_started: 1, setup_desktop_PRIVATE_CANARY: 1 } }
  const response = await app.inject({ method: 'POST', url: '/api/product-usage/setup', payload: setup })
  expect(response.statusCode).toBe(200)
  expect(methods.ingestSetupUsage).toHaveBeenCalledExactlyOnceWith(
    { ...setup, counters: { setup_desktop_sign_in_started: 1 } })
})
it('does not reflect a database error or report contents', async () => {
  methods.ingestProductUsage.mockRejectedValue(new Error('PRIVATE_CANARY'))
  const response = await submit(good)
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('PRIVATE_CANARY')
})
it('returns retryable backpressure without admitting another database write', async () => {
  methods.ingestProductUsage.mockRejectedValue({ code: 'USAGE_BUSY', message: 'PRIVATE_CANARY' })
  const response = await submit(good)
  expect(response.statusCode).toBe(429)
  expect(response.json().error.code).toBe('USAGE_BUSY')
  expect(response.body).not.toContain('PRIVATE_CANARY')
})
it.each([['P2034', 'USAGE_WRITE_CONFLICT'], ['P2002', 'USAGE_WRITE_CONFLICT'],
  ['P2028', 'USAGE_TRANSACTION_FAILED'], ['PRIVATE_CANARY', 'USAGE_UNAVAILABLE']])(
  'returns only the fixed delivery category for storage error %s', async (code, expected) => {
    methods.ingestProductUsage.mockRejectedValue(Object.assign(new Error('PRIVATE_CANARY'), { code, meta: 'PRIVATE_CANARY' }))
    const response = await submit(good)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe(expected)
    expect(response.body).not.toContain('PRIVATE_CANARY')
  },
)
it('accepts the same native Desktop report exercised through the real daemon proxy', async () => {
  const report = JSON.parse(readFileSync(new URL('../../../tests/fixtures/desktop-product-usage-report.json', import.meta.url), 'utf8'))
  expect((await submit(report)).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledExactlyOnceWith('account', report)
})
it('also sanitizes malformed JSON and oversized bodies before schema validation', async () => {
  for (const payload of ['{"prompt":"PRIVATE_CANARY', JSON.stringify({ prompt: 'PRIVATE_CANARY'.repeat(1000) })]) {
    const response = await app.inject({ method: 'POST', url: '/api/product-usage/report', headers: {
      authorization: 'fixture', 'content-type': 'application/json',
    }, payload })
    expect([400, 413]).toContain(response.statusCode)
    expect(response.body).not.toContain('PRIVATE_CANARY')
    expect(methods.ingestProductUsage).not.toHaveBeenCalled()
  }
})
it('does not expose preference lookup failures', async () => {
  methods.productUsageChoice.mockRejectedValue(new Error('PRIVATE_CANARY'))
  const response = await app.inject({ method: 'GET', url: '/api/product-usage/settings', headers: { authorization: 'fixture' } })
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('PRIVATE_CANARY')
})
it('the visible control changes only the authenticated account', async () => {
  const request = { method: 'POST' as const, url: '/api/product-usage/settings', headers: { authorization: 'fixture' }, payload: { enabled: false } }
  expect((await app.inject(request)).statusCode).toBe(200)
  expect(methods.setProductUsageChoice).toHaveBeenCalledWith('account', false)
  expect((await app.inject({ ...request, payload: { enabled: true, userId: 'another' } })).statusCode).toBe(400)
})

it('the complete vocabulary fits bounded chunks, including the longest metric keys', async () => {
  for (let i = 0; i < PRODUCT_USAGE_METRICS.length; i += 64) {
    const payload = { ...good, context: { surface: 'desktop', release: '999.999.999', platform: 'windows', channel: 'production' }, counters: Object.fromEntries(PRODUCT_USAGE_METRICS.slice(i, i + 64).map(k => [k, PRODUCT_USAGE_MAX_COUNT])) }
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(8192)
    expect((await submit(payload)).statusCode).toBe(200)
  }
})

it('takes the CLI\'s launch codes, late launch failures and first launches by engine, and still no name outside the list', async () => {
  const context = { surface: 'cli', release: '0.4.9', platform: 'macos', channel: 'production' }
  const counters = { launch_failed_other: 2, launch_failed_code_invalid_prompt: 1, launch_failed_code_unlisted: 1,
    launch_late_failed: 1, launch_late_failed_code_engine_did_not_start: 1, create_error_code_none: 1,
    resume_error_code_session_not_found: 1, first_launch_engine_claude: 1, first_launch_claude_signed_in: 1,
    first_launch_engine_other: 1, first_launch_codex_unknown: 1 }
  expect((await submit({ ...good, context, counters })).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledWith('account', expect.objectContaining({ counters }))
  methods.ingestProductUsage.mockClear()
  // A name outside the list is never stored: the report keeps its known counters without it (an unknown
  // name no longer refuses the whole report), and alone it is still refused.
  for (const name of ['launch_failed_code_PRIVATE_CANARY', 'launch_failed_code_ENGINE_DID_NOT_START', 'restart_error_code_internal',
    'first_launch_engine_cursor', 'first_launch_opencode_signed_in', 'launch_late_failed_other']) {
    const response = await submit({ ...good, context, counters: { launch_late_failed: 1, [name]: 1 } })
    expect(response.statusCode, name).toBe(200)
    expect(response.body).not.toContain('PRIVATE_CANARY')
    expect(methods.ingestProductUsage).toHaveBeenLastCalledWith('account', expect.objectContaining(
      { counters: { launch_late_failed: 1, health_cli_report_unknown_metric: 1 } }))
    expect((await submit({ ...good, context, counters: { [name]: 1 } })).statusCode, name).toBe(400)
  }
})

it('takes a phone build context: its release and iOS or Android, nothing finer', async () => {
  for (const platform of ['ios', 'android']) {
    const response = await submit({ ...good, context: { surface: 'phone', release: '1.0.3', platform, channel: 'production' } })
    expect(response.statusCode).toBe(200)
  }
  const model = await submit({ ...good, context: { surface: 'phone', release: '1.0.3', platform: 'iPhone15,2', channel: 'production' } })
  expect(model.statusCode).toBe(400)
})

it('takes how the phone opened Find or Computers, and the phone\'s own requests, and nothing else', async () => {
  const context = { surface: 'phone', release: '1.0.4', platform: 'ios', channel: 'production' }
  const counters = { ui_phone_screen_find_swipe: 2, ui_phone_screen_find_button: 1, ui_phone_screen_computers_swipe: 1,
    ui_phone_screen_computers_button: 1, request_phone_create_started: 1, request_phone_resume_error_other: 1,
    request_phone_resume_reason_busy: 1 }
  expect((await submit({ ...good, context, counters })).statusCode).toBe(200)
  for (const name of ['ui_phone_screen_settings_swipe', 'ui_phone_screen_find_pinch', 'ui_desktop_screen_find_swipe']) {
    expect((await submit({ ...good, context, counters: { [name]: 1 } })).statusCode).toBe(400)
  }
})

it('rejects extra context, custom versions and device fingerprints without echoing them', async () => {
  const context = { surface: 'desktop', release: '1.2.73', platform: 'macos', channel: 'production' }
  for (const c of [{ ...context, path: 'PRIVATE_CANARY' }, { ...context, release: 'PRIVATE_CANARY' },
    { ...context, platform: 'PRIVATE_CANARY' }, { ...context, channel: 'PRIVATE_CANARY' }]) {
    const response = await submit({ ...good, context: c })
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain('PRIVATE_CANARY')
  }
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
})

const setup = { schemaVersion: 1, consent: true, id: good.id, day: good.day, counters: { setup_desktop_sign_in_started: 1 } }
const sendSetup = (payload: unknown = setup, headers = {}) => app.inject({ method: 'POST', url: '/api/product-usage/setup', payload: payload as Record<string, unknown>, headers })
it('keeps legacy explicit setup opt-in without credentials or account lookup', async () => {
  expect((await sendSetup()).statusCode).toBe(200)
  expect(methods.ingestSetupUsage).toHaveBeenCalledWith(setup)
  expect(methods.productUsageChoice).not.toHaveBeenCalled()
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
  for (const payload of [{ ...setup, consent: false }, { ...setup, account: 'PRIVATE_CANARY' },
    { ...setup, counters: { turns_started: 1 } }, { ...setup, counters: { setup_desktop_sign_in_started: 1001 } },
    // hn has no signed-out channel: it counts only through its signed-in daemon.
    { ...setup, counters: { setup_tui_sign_in_started: 1 } }, { ...setup, counters: { ui_tui_sign_in_started: 1 } }]) {
    const response = await sendSetup(payload)
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('PRIVATE_CANARY')
  }
  for (const headers of [{ authorization: 'fixture' }, { cookie: 'PRIVATE_CANARY' }]) expect((await sendSetup(setup, headers)).statusCode).toBe(400)
})
it('accepts default-on sharing only for Desktop or phone setup, one at a time, without asserting consent', async () => {
  const { consent: _, ...fields } = setup
  const report = { ...fields, sharing: 'default' }
  const phone = { ...report, counters: { setup_phone_sign_in_started: 1, setup_phone_sign_in_google_ok: 1 } }
  for (const accepted of [report, phone]) {
    expect((await sendSetup(accepted)).statusCode).toBe(200)
    expect(methods.ingestSetupUsage).toHaveBeenCalledWith(accepted)
  }
  expect(methods.productUsageChoice).not.toHaveBeenCalled()
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
  methods.ingestSetupUsage.mockClear()
  for (const payload of [fields, { ...report, consent: true }, { ...report, sharing: 'off' },
    { ...report, counters: { setup_web_sign_in_started: 1 } },
    { ...report, counters: { ...setup.counters, setup_phone_sign_in_started: 1 } },
    { ...report, counters: { ui_desktop_sign_in_started: 1 } },
    { ...report, account: 'PRIVATE_CANARY' }]) {
    const response = await sendSetup(payload)
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('PRIVATE_CANARY')
  }
  for (const headers of [{ authorization: 'fixture' }, { cookie: 'PRIVATE_CANARY' }]) {
    expect((await sendSetup(report, headers)).statusCode).toBe(400)
  }
  expect(methods.ingestSetupUsage).not.toHaveBeenCalled()
})
it('bounds untrusted setup writes independently of signed-in reports', async () => {
  let finish!: (value: unknown) => void
  methods.ingestSetupUsage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  // A shared deferred completion releases all four admitted requests.
  const done = new Promise(resolve => { finish = resolve })
  methods.ingestSetupUsage.mockReturnValue(done)
  const pending = Array.from({ length: 4 }, () => sendSetup().then((r: { statusCode: number }) => r.statusCode))
  await vi.waitFor(() => expect(methods.ingestSetupUsage).toHaveBeenCalledTimes(4))
  expect((await sendSetup()).statusCode).toBe(429)
  expect((await submit(good)).statusCode).toBe(200)
  finish({ accepted: true })
  expect(await Promise.all(pending)).toEqual([200, 200, 200, 200])
})

it('feedback reduces a voluntary fixed choice to one unlinked, retry-safe count', async () => {
  const request = { method: 'POST' as const, url: '/api/product-usage/feedback', headers: { authorization: 'fixture' }, payload: { id: good.id, answer: 'useful' } }
  expect((await app.inject(request)).statusCode).toBe(200)
  expect(methods.ingestProductUsage).toHaveBeenCalledWith('account', expect.objectContaining({ id: good.id, revision: 0, counters: { feedback_useful: 1 } }))
  methods.ingestProductUsage.mockClear()
  const bad = await app.inject({ ...request, payload: { ...request.payload, task: 'PRIVATE_CANARY' } })
  expect(bad.statusCode).toBe(400); expect(bad.body).not.toContain('PRIVATE_CANARY')
  methods.productUsageChoice.mockResolvedValue({ enabled: false, revision: 1 })
  expect((await app.inject(request)).statusCode).toBe(409)
  expect(methods.ingestProductUsage).not.toHaveBeenCalled()
})
