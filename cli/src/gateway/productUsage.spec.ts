import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_USAGE_METRICS } from '../lib/productUsageContract.js'
import { createProductUsage, type ProductUsageDeps } from './productUsage.js'

let dir: string, file: string, now: number, enabled: boolean, revision: number
let usage: ReturnType<typeof createProductUsage>
let sent: unknown[], retry: boolean
let request: ReturnType<typeof vi.fn<ProductUsageDeps['request']>>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-product-usage-')); file = join(dir, 'counts.json')
  now = Date.parse('2026-10-12T10:00:00Z'); enabled = true; revision = 0; sent = []; retry = false
  request = vi.fn(async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { status: 200, body: { data: { enabled, revision } } }
    sent.push(structuredClone(body))
    return { status: retry ? 503 : 200, body: { data: { accepted: !retry } } }
  })
  usage = createProductUsage({ file, now: () => now, request })
})
afterEach(async () => { await usage.stop(); rmSync(dir, { recursive: true, force: true }) })
const totals = () => {
  const result: Record<string, number> = {}
  for (const report of sent as { counters: Record<string, number> }[]) for (const [k, v] of Object.entries(report.counters)) result[k] = (result[k] ?? 0) + v
  return result
}

it('keeps upgrade backlogs unattributed and fences explicit-work intent on unavailable consent', async () => {
  await usage.stop()
  const context = { surface: 'cli', release: '0.3.95', platform: 'macos', channel: 'production' } as const
  usage = createProductUsage({ file, now: () => now, request, context })
  await usage.sync()
  usage.launch({ id: 'PRIVATE_USER_INTENT', phase: 'work_requested', origin: 'interactive' })
  usage.observe('turn_started', 'PRIVATE_USER_INTENT', false)
  usage.observe('turn_ended', 'PRIVATE_USER_INTENT', false)
  await usage.stop()
  usage = createProductUsage({ file, now: () => now, request, context: { ...context, release: '0.3.96' } })
  await usage.sync(); await usage.sync()
  const workReport = (sent as { counters: Record<string, number>; context: typeof context }[]).find(r => r.counters.health_cli_interactive_work_days)
  expect(workReport?.context.release).toBe('unknown')
  expect(totals().health_cli_first_interactive_work).toBe(1)
  usage.launch({ id: 'PRIVATE_STALE_INTENT', phase: 'work_requested', origin: 'interactive' })
  request.mockResolvedValueOnce({ status: 503, body: {} })
  await usage.sync(); await usage.sync()
  usage.observe('turn_started', 'PRIVATE_STALE_INTENT', false); await usage.sync()
  expect(totals().health_cli_unclassified_turns_started).toBe(1)
  expect(JSON.stringify(sent)).not.toContain('PRIVATE')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE')
})

it('keeps first-launch 24-hour value counts on their original cohort day across restart, without an identity', async () => {
  await usage.sync()
  now = Date.parse('2026-10-12T23:30:00Z')
  usage.launch({ id: 'PRIVATE_CREATION_CANARY', phase: 'start' }); await usage.sync(); await usage.stop()
  usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  now += 2 * 3600000
  usage.observe('turn_started', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('text_delta', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('text_delta', 'PRIVATE_AGENT_CANARY', false)
  usage.observe('turn_ended', 'PRIVATE_AGENT_CANARY', false)
  await usage.sync(); await usage.sync()
  expect(totals()).toMatchObject({ first_launch_installations: 1, first_launch_work_24h_installations: 1, first_launch_response_24h_installations: 1 })
  const cohortReports = (sent as { day: string; counters: Record<string, number> }[]).filter(r => r.counters.first_launch_response_24h_installations)
  expect(cohortReports.map(r => r.day)).toEqual(['2026-10-12'])
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_')
})

it('does not count late work as first-launch 24-hour value or restart the cohort for another launch', async () => {
  await usage.sync(); usage.launch({ id: 'synthetic-creation-1', phase: 'start' })
  now += 86400001
  usage.launch({ id: 'synthetic-creation-2', phase: 'start' })
  usage.observe('turn_started', 'a', false); usage.observe('text_delta', 'a', false)
  await usage.sync(); await usage.sync()
  expect(totals().first_launch_installations).toBe(1)
  expect(totals().first_launch_response_24h_installations).toBeUndefined()
})

it('collects nothing before it can check the preference, and respects off', async () => {
  usage.observe('turn_started', 'private-agent', false)
  enabled = false
  await usage.sync()
  usage.observe('turn_started', 'private-agent', false)
  usage.opened('desktop'); await usage.sync()
  expect(sent).toEqual([])
})

it('discards a permanently invalid packet so later reports and loss counts can recover', async () => {
  await usage.sync(); usage.counter('search_requests')
  request.mockImplementationOnce(async () => ({ status: 200, body: { data: { enabled: true, revision: 0 } } }))
    .mockImplementationOnce(async () => ({ status: 400, body: {} }))
  await usage.sync()
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
  await usage.sync()
  expect(totals().health_cli_report_rejected).toBe(1)
  expect(totals().health_cli_report_failure_invalid).toBe(1)
})

it('sends hn\'s counters alone, so a backend from before `tui` refuses only them', async () => {
  const tui = (metric: string) => metric.startsWith('ui_tui_') || metric.startsWith('health_tui_')
  await usage.sync()
  usage.counter('ui_tui_sign_in_started'); usage.counter('search_requests'); usage.counter('health_tui_funnel_first_work')
  usage.counter('ui_desktop_sign_in_ok'); usage.counter('ui_tui_sign_in_ok'); usage.counter('tui_opens')
  // That backend's strict vocabulary: one unknown name makes the whole report invalid.
  const accepted: Record<string, number>[] = []
  request.mockImplementation(async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { status: 200, body: { data: { enabled: true, revision: 0 } } }
    const counters = (body as { counters: Record<string, number> }).counters
    sent.push(structuredClone(body))
    if (Object.keys(counters).some(tui)) return { status: 400, body: { error: { code: 'INVALID_USAGE_REPORT' } } }
    accepted.push(counters)
    return { status: 200, body: { data: { accepted: true } } }
  })
  for (let i = 0; i < 4; i++) await usage.sync()
  for (const report of sent as { counters: Record<string, number> }[]) {
    const names = Object.keys(report.counters)
    expect(names.every(tui) || !names.some(tui), names.join()).toBe(true)
  }
  const kept = Object.assign({}, ...accepted)
  expect(kept).toMatchObject({ search_requests: 1, ui_desktop_sign_in_ok: 1, tui_opens: 1 })
  expect(Object.keys(kept).some(tui)).toBe(false)
  // Its refusal is hn's alone: no delivery failure is counted for it.
  expect(kept.health_cli_report_rejected).toBeUndefined()
  expect(kept.health_cli_report_failure_invalid).toBeUndefined()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pending: null, days: {} })
  // Refused for the rest of the UTC day: hn's counts are dropped, not sent again or kept to age.
  const refusals = () => (sent as { counters: Record<string, number> }[]).filter(r => Object.keys(r.counters).some(tui)).length
  expect(refusals()).toBe(1)
  usage.counter('ui_tui_viewer_open_started'); usage.counter('search_requests')
  for (let i = 0; i < 3; i++) await usage.sync()
  expect(refusals()).toBe(1)
  expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).days)).not.toContain('_tui_')
  // The next UTC day (an updated backend, say) takes them again.
  now += 86_400_000
  request.mockImplementation(async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { status: 200, body: { data: { enabled: true, revision: 0 } } }
    sent.push(structuredClone(body))
    return { status: 200, body: { data: { accepted: true } } }
  })
  usage.counter('ui_tui_viewer_open_started')
  for (let i = 0; i < 3; i++) await usage.sync()
  expect(totals().ui_tui_viewer_open_started).toBe(1)
})

it('holds hn\'s observations until the first choice read: counted when sharing is on, discarded when off', async () => {
  usage.counter('ui_tui_remote_connect_started'); usage.counter('health_tui_funnel_first_work'); usage.counter('search_requests')
  await usage.sync(); await usage.sync()
  expect(totals()).toMatchObject({ ui_tui_remote_connect_started: 1, health_tui_funnel_first_work: 1 })
  expect(totals().search_requests).toBeUndefined()

  await usage.stop(); sent = []; enabled = false
  rmSync(file, { force: true })
  usage = createProductUsage({ file, now: () => now, request })
  for (let i = 0; i < 70; i++) usage.counter('ui_tui_remote_connect_started')
  await usage.sync()
  enabled = true
  await usage.sync(); await usage.sync()
  expect(totals().ui_tui_remote_connect_started).toBeUndefined()
})

it('keeps holding hn\'s observations through a failed choice read, bounded, and counts them once sharing is known on', async () => {
  request.mockResolvedValueOnce({ status: 503, body: {} })
  for (let i = 0; i < 70; i++) usage.counter('ui_tui_remote_connect_started')
  await usage.sync()
  expect(sent).toEqual([])
  await usage.sync(); await usage.sync(); await usage.sync()
  expect(totals().ui_tui_remote_connect_started).toBe(64)
})

it.each([
  [503, 'USAGE_WRITE_CONFLICT', 'write_conflict'], [503, 'USAGE_TRANSACTION_FAILED', 'transaction'],
  [504, 'BACKEND_TIMEOUT', 'timeout'], [502, 'BACKEND_UNREACHABLE', 'unreachable'],
  [429, 'PRIVATE_CANARY', 'rate_limited'], [502, 'AUTH_UNAVAILABLE', 'auth'],
])('retains an immutable report on %i and queues only its fixed %s category', async (status, code, category) => {
  await usage.sync(); usage.counter('search_requests')
  request.mockResolvedValueOnce({ status: 200, body: { data: { enabled: true, revision: 0 } } })
    .mockResolvedValueOnce({ status: status as number, body: { error: { code, message: 'PRIVATE_CANARY' } } })
  await usage.sync()
  const pending = JSON.parse(readFileSync(file, 'utf8')).pending
  expect(pending.counters.search_requests).toBe(1)
  await usage.sync(); await usage.sync()
  expect(sent[0]).toEqual(pending)
  expect(totals()[`health_cli_report_failure_${category}`]).toBe(1)
  expect(totals().health_cli_report_rejected).toBe(1)
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CANARY')
})

it('reduces turns locally, excludes replay, and never persists or uploads agent identity', async () => {
  await usage.sync()
  usage.opened('desktop')
  usage.observe('turn_started', 'PRIVATE_CANARY', true)
  usage.observe('turn_started', 'PRIVATE_CANARY', false)
  usage.observe('turn_started', 'PRIVATE_CANARY', false)
  now += 22_000
  usage.observe('turn_ended', 'PRIVATE_CANARY', false)
  usage.observe('turn_ended', 'PRIVATE_CANARY', false)
  await usage.sync()
  expect(totals()).toMatchObject({ active_installation_days: 1, working_installation_days: 1, first_work_installations: 1,
    weekly_working_installations: 1, turns_started: 1, turns_ended: 1, duration_10s_to_1m: 1, desktop_opens: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CANARY')
  expect(sent[0]).not.toHaveProperty('userId')
})

it('keeps the receipt immutable across uncertain responses and process restarts', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true
  await usage.sync(); const first = structuredClone(sent[0]); await usage.stop()
  usage = createProductUsage({ file, now: () => now, request })
  retry = false; await usage.sync()
  expect(sent[1]).toEqual(first)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
})

it('drops a pre-opt-out queue even if the next observed choice is on again', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  revision = 2; retry = false
  await usage.sync()
  expect(sent).toHaveLength(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
})

it('counts repeat days and consecutive weeks once, independently of event volume', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false); await usage.sync()
  now = Date.parse('2026-10-13T10:00:00Z')
  usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false, true); await usage.sync()
  now = Date.parse('2026-10-19T10:00:00Z')
  usage.observe('turn_started', 'a', false); await usage.sync()
  // Cohort returns use earlier day buckets; the bounded uploader sends one day per sync.
  for (let i = 0; i < 4; i++) await usage.sync()
  expect(totals()).toMatchObject({ working_installation_days: 3, repeat_work_installation_days: 2,
    first_work_installations: 1, weekly_working_installations: 2, weekly_returning_installations: 1, turns_interrupted: 1 })
})

it('treats unknown preference and unavailable servers as missing coverage', async () => {
  request.mockResolvedValue({ status: 503, body: {} })
  await usage.sync(); usage.observe('turn_started', 'a', false)
  expect(sent).toHaveLength(0)
})

it('rebuilds a persisted report from its allowlist, removing content injected into local storage', async () => {
  await usage.stop()
  writeFileSync(file, JSON.stringify({ revision: 0, days: { '2026-10-12': { turns_started: 1, prompt: 'PRIVATE_CANARY' } },
    pending: { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-12',
      counters: { turns_ended: 1, result: 'PRIVATE_CANARY' }, prompt: 'PRIVATE_CANARY' } }))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync(); await usage.sync()
  expect(totals()).toEqual({ turns_ended: 1, turns_started: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CANARY')
})

it('expires pending reports instead of replaying them beyond the server dedupe window', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  now += 36 * 86400000; retry = false
  await usage.sync()
  expect(sent).toHaveLength(1)
})

it('can discard its queue when the signed-in account changes', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  await usage.stop(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).pending).toBeNull()
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('ignores an oversized local file and starts a bounded queue', async () => {
  await usage.stop(); writeFileSync(file, ' '.repeat(300_000))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync(); usage.observe('turn_started', 'a', false); await usage.sync()
  expect(totals().turns_started).toBe(1)
  expect(readFileSync(file).length).toBeLessThan(64 * 1024)
})

it('counts first-response latency, silent waits and errors once without reading content', async () => {
  await usage.sync(); usage.observe('turn_started', 'PRIVATE_AGENT', false)
  now += 61_000; await usage.sync(); await usage.sync()
  usage.observe('error', 'PRIVATE_AGENT', false); usage.observe('error', 'PRIVATE_AGENT', false)
  usage.observe('text_delta', 'PRIVATE_AGENT', true)
  usage.observe('text_delta', 'PRIVATE_AGENT', false); usage.observe('text_delta', 'PRIVATE_AGENT', false)
  usage.observe('turn_ended', 'PRIVATE_AGENT', false)
  usage.observe('turn_started', 'another', false); usage.observe('turn_ended', 'another', false)
  await usage.sync()
  expect(totals()).toMatchObject({ turns_waiting_over_1m: 1, turns_with_error: 1, turns_with_response: 1,
    response_1m_to_5m: 1, first_response_installations: 1, turns_ended_without_response: 1 })
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_AGENT')
})

it('attributes D1/D7 return to the original working day, surviving restarts and deduplicating turns', async () => {
  const work = async () => { usage.observe('turn_started', 'a', false); usage.observe('turn_ended', 'a', false); await usage.sync() }
  await usage.sync(); await work(); await usage.stop()
  now += 86400000; usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  await work(); await work()
  now += 6 * 86400000; await work()
  await usage.sync() // the remaining current-day batch
  const returns = (sent as {day: string; counters: Record<string, number>}[]).filter(r => r.counters.d1_returning_work_installations || r.counters.d7_returning_work_installations)
  expect(returns.map(r => r.day)).toEqual(['2026-10-12', '2026-10-12'])
  expect(totals()).toMatchObject({ d1_returning_work_installations: 1, d7_returning_work_installations: 1 })
})

it('accepts only known scalar counters and stops diagnostics with the privacy choice', async () => {
  await usage.sync(); usage.counter('create_requests'); usage.counter('PRIVATE_CANARY' as never); await usage.sync()
  enabled = false; await usage.sync(); usage.counter('create_failed'); await usage.sync()
  expect(totals()).toEqual({ create_requests: 1, create_installation_days: 1, create_first_installations: 1, measurement_v2_installation_days: 1 })
})

it('counts a read the apps make on their own for reliability only, never as a feature someone used', async () => {
  // agent_recent after every agent update, dsh_list on every connect, the pickers' model lists and
  // session previews: prod's first day read 41,179 "history" requests across 72 "history"
  // installation-days, almost every active one, without anyone opening a history.
  await usage.sync()
  for (const metric of ['history_requests', 'history_ok', 'history_under_1s', 'history_page_requests',
    'store_list_requests', 'model_list_requests', 'model_list_failed'] as const) usage.counter(metric)
  usage.counter('search_requests')
  await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1,
    history_requests: 1, history_ok: 1, history_under_1s: 1, history_page_requests: 1,
    store_list_requests: 1, model_list_requests: 1, model_list_failed: 1,
    search_requests: 1, search_installation_days: 1, search_first_installations: 1 })
})

it('counts the Store or a model list as used only when a person opened it, once a day', async () => {
  await usage.sync()
  usage.counter('store_list_requests'); usage.counter('store_list_user_requests'); usage.counter('store_list_user_requests')
  await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1, store_list_requests: 1, store_list_user_requests: 2,
    store_list_user_installation_days: 1, store_list_user_first_installations: 1 })
  now += 86400000; await usage.stop(); usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  usage.counter('store_list_user_requests'); usage.counter('model_list_user_requests')
  await usage.sync()
  expect(totals()).toMatchObject({ store_list_user_installation_days: 2, store_list_user_repeat_installation_days: 1,
    store_list_user_first_installations: 1, model_list_user_first_installations: 1 })
  expect(totals()).not.toHaveProperty('store_list_installation_days')
})

it('tracks a durable launch through polls without persisting its receipt or counting polls as attempts', async () => {
  await usage.sync()
  const id = 'PRIVATE_CREATION_CANARY'
  usage.launch({ id, phase: 'start' }); usage.launch({ id, phase: 'start' })
  usage.launch({ id, phase: 'pending', wait: 'install' }); usage.launch({ id, phase: 'pending', wait: 'install' })
  now += 65_000
  usage.launch({ id, phase: 'failed', failure: 'setup' }); usage.launch({ id, phase: 'failed', failure: 'setup' })
  await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1, first_launch_installations: 1, first_launch_engine_other: 1, launch_started: 1, launch_wait_install: 1, launch_failed: 1, launch_failed_setup: 1, launch_failed_setup_code_unlisted: 1, launch_1m_to_5m: 1 })
  expect(JSON.stringify(sent) + readFileSync(file, 'utf8')).not.toContain(id)
})

it('calls an unobserved launch unknown, not failed, and drops launch observations on opt-out', async () => {
  await usage.sync(); usage.launch({ id: 'fixture-creation-one', phase: 'start' })
  now += 16 * 60_000; await usage.sync()
  expect(totals()).toEqual({ measurement_v2_installation_days: 1, first_launch_installations: 1, first_launch_engine_other: 1, launch_started: 1, launch_unobserved: 1 })
  usage.launch({ id: 'fixture-creation-two', phase: 'start' }); enabled = false; await usage.sync()
  enabled = true; revision++; await usage.sync()
  usage.launch({ id: 'fixture-creation-two', phase: 'created' }); await usage.sync()
  expect(totals().launch_created).toBeUndefined()
})


it('batches the complete vocabulary below the wire bound without losing counts', async () => {
  await usage.sync()
  for (const metric of PRODUCT_USAGE_METRICS) usage.counter(metric)
  for (let i = 0; i < Math.ceil(PRODUCT_USAGE_METRICS.length / 64) + 3; i++) await usage.sync()
  for (const report of sent) expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(8192)
  // Summed once: summing every report again for each of the vocabulary's names took most of this test's time.
  const all = totals()
  for (const metric of PRODUCT_USAGE_METRICS) expect(all[metric], metric).toBeGreaterThanOrEqual(1)
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('counts feature reach and repeat use once per installation day, independently of requests', async () => {
  await usage.sync()
  usage.counter('store_install_requests'); usage.counter('store_install_requests'); await usage.sync()
  await usage.stop()
  usage = createProductUsage({ file, now: () => now, request }); await usage.sync()
  usage.counter('store_install_requests'); await usage.sync()
  now += 86400000
  usage.counter('store_install_requests'); await usage.sync()
  expect(totals()).toMatchObject({ store_install_requests: 4, store_install_installation_days: 2,
    store_install_first_installations: 1, store_install_repeat_installation_days: 1 })
})

it('attributes four-week return to its original day and counts consecutive calendar months', async () => {
  const work = () => { usage.observe('turn_started', 'synthetic', false); usage.observe('turn_ended', 'synthetic', false) }
  await usage.sync(); work(); await usage.sync()
  now += 28 * 86400000; work()
  await usage.sync(); await usage.sync()
  expect(totals()).toMatchObject({ d28_returning_work_installations: 1, monthly_working_installations: 2,
    monthly_returning_installations: 1, reactivated_after_7d_installations: 1 })
  const report = (sent as { day: string; counters: Record<string, number> }[]).find(r => r.counters.d28_returning_work_installations)
  expect(report?.day).toBe('2026-10-12')
})

it('keeps memory and disk bounded during a long reporting outage', async () => {
  await usage.sync()
  for (let day = 0; day < 35; day++) {
    for (const metric of PRODUCT_USAGE_METRICS) usage.counter(metric)
    now += 86400000
  }
  await usage.stop()
  expect(Buffer.byteLength(readFileSync(file))).toBeLessThanOrEqual(256 * 1024)
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).days).length).toBeLessThanOrEqual(35)
})

it('does not upload before persistence or block observers on a slow disk, and fences stop during a save', async () => {
  await usage.stop()
  let release: (() => void) | undefined, writes = 0, block = false
  usage = createProductUsage({ file, now: () => now, request, write: async (_file, data) => {
    writes++
    if (block) await new Promise<void>(resolve => { release = resolve })
    writeFileSync(file, data)
  } })
  await usage.sync(); block = true
  usage.counter('create_requests')
  const flushing = usage.sync()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const before = writes
  for (let i = 0; i < 1000; i++) usage.counter('create_requests')
  expect(writes).toBe(before)
  expect(sent).toHaveLength(0)
  const stopped = usage.stop(true)
  block = false; release!()
  await stopped; await flushing
  expect(sent).toHaveLength(0)
  expect(JSON.parse(readFileSync(file, 'utf8')).days).toEqual({})
})

it('drops a corrupt oversized pending report without sending an oversized request', async () => {
  await usage.stop()
  writeFileSync(file, JSON.stringify({ revision: 0, pending: {
    schemaVersion: 1, revision: 0, id: '12345678-1234-4234-8234-123456789012', day: '2026-10-12',
    counters: Object.fromEntries(PRODUCT_USAGE_METRICS.map(metric => [metric, 100000])),
  } }))
  usage = createProductUsage({ file, now: () => now, request })
  await usage.sync()
  expect(sent).toHaveLength(0)
  usage.observe('turn_started', 'PRIVATE_AGENT', false); await usage.sync()
  expect(totals().turns_started).toBe(1)
  expect(Buffer.byteLength(JSON.stringify(sent[0]))).toBeLessThan(8192)
})

const CLI = { surface: 'cli', release: '0.4.9', platform: 'macos', channel: 'production' } as const
const ID = 'fixture-creation-one'
const flush = async () => { for (let i = 0; i < 4; i++) await usage.sync() }

it('names the code of an `other` launch failure, so the codes add up to launch_failed_other', async () => {
  await usage.sync()
  const fail = (id: string, signal: Partial<Parameters<typeof usage.launch>[0]>) => {
    usage.launch({ id, phase: 'start' }); usage.launch({ id, phase: 'failed', ...signal })
  }
  fail('fixture-creation-one', { failure: 'other', code: 'invalid_prompt' })
  fail('fixture-creation-two', { failure: 'other', code: 'PRIVATE_CANARY' as never })
  fail('fixture-creation-three', { failure: 'other' })
  fail('fixture-creation-four', { failure: 'other', code: 'none' })
  fail('fixture-creation-five', { failure: 'setup', code: 'invalid_prompt' })
  await flush()
  const t = totals()
  expect(t).toMatchObject({ launch_failed: 5, launch_failed_other: 4, launch_failed_setup: 1,
    launch_failed_code_invalid_prompt: 1, launch_failed_code_unlisted: 2, launch_failed_code_none: 1 })
  const codes = Object.entries(t).filter(([name]) => name.startsWith('launch_failed_code_')).reduce((n, [, v]) => n + v, 0)
  expect(codes).toBe(t.launch_failed_other)
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
})

it('counts correct refusals and agents\' launches apart from people\'s failures', async () => {
  await usage.sync()
  usage.launch({ id: 'fixture-agent-refused', phase: 'start', agentStarted: true })
  for (let poll = 0; poll < 2; poll++) usage.launch({ id: 'fixture-agent-refused', phase: 'refused', code: 'session_in_harness' })
  usage.launch({ id: 'fixture-person-failed', phase: 'start' })
  usage.launch({ id: 'fixture-person-failed', phase: 'failed', failure: 'setup', code: 'spawn_failed' })
  usage.launch({ id: 'fixture-agent-created', phase: 'start', agentStarted: true })
  usage.launch({ id: 'fixture-agent-created', phase: 'created' })
  usage.launch({ id: 'fixture-agent-failed-1', phase: 'start', agentStarted: true })
  usage.launch({ id: 'fixture-agent-failed-1', phase: 'failed', failure: 'other', code: 'internal' })
  usage.launch({ id: 'fixture-person-refused', phase: 'start' })
  usage.launch({ id: 'fixture-person-refused', phase: 'refused', code: 'PRIVATE_CANARY' as never })
  await flush()
  const t = totals()
  expect(t).toMatchObject({ launch_started: 5, launch_agent_started: 3, launch_refused: 2, launch_agent_refused: 1,
    launch_refused_code_session_in_harness: 1, launch_refused_code_unlisted: 1, launch_failed: 2, launch_agent_failed: 1,
    launch_created: 1, launch_agent_created: 1 })
  // A refusal is no failure of either kind, and the failure kinds still add up to launch_failed.
  expect(t.launch_failed_setup + t.launch_failed_other).toBe(t.launch_failed)
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
})

it('counts a setup launch reason once across polls, separately from other failures and without retaining identifiers', async () => {
  await usage.sync()
  for (const [index, code] of ['tmux_unavailable', 'native_launch_held', 'PRIVATE_CANARY' as never].entries()) {
    const id = `PRIVATE_CREATION_${index}`
    usage.launch({ id, phase: 'start' })
    for (let poll = 0; poll < 2; poll++) usage.launch({ id, phase: 'failed', failure: 'setup', code: code as never })
  }
  await flush()
  const t = totals()
  expect(t).toMatchObject({ launch_started: 3, launch_failed: 3, launch_failed_setup: 3,
    launch_failed_setup_code_tmux_unavailable: 1, launch_failed_setup_code_native_launch_held: 1, launch_failed_setup_code_unlisted: 1 })
  expect(Object.entries(t).filter(([name]) => name.startsWith('launch_failed_setup_code_')).reduce((sum, [, count]) => sum + count, 0)).toBe(t.launch_failed_setup)
  expect(Object.keys(t).some(name => name.startsWith('launch_failed_code_'))).toBe(false)
  expect(JSON.stringify(sent) + readFileSync(file, 'utf8')).not.toContain('PRIVATE_')
})

it('counts a created launch whose engine then did not start as a late failure, once, by its code', async () => {
  await usage.sync()
  usage.launch({ id: ID, phase: 'start' })
  usage.launch({ id: ID, phase: 'created', agent: 'PRIVATE_AGENT_CANARY' })
  usage.launchState('PRIVATE_AGENT_CANARY', 'starting')
  usage.launchState('PRIVATE_AGENT_CANARY', 'failed', 'engine_did_not_start')
  usage.launchState('PRIVATE_AGENT_CANARY', 'failed', 'engine_did_not_start')
  // An agent that started is no late failure, and neither is one no launch here created.
  usage.launch({ id: 'fixture-creation-two', phase: 'start' })
  usage.launch({ id: 'fixture-creation-two', phase: 'created', agent: 'started-agent' })
  usage.launchState('started-agent', 'ready'); usage.launchState('started-agent', 'failed', 'start_timeout')
  usage.launchState('another-agent', 'failed', 'start_timeout')
  // Already failed when a status poll's reply said created.
  usage.launch({ id: 'fixture-creation-three', phase: 'start' })
  usage.launch({ id: 'fixture-creation-three', phase: 'created', late: true, code: 'start_timeout' })
  usage.launch({ id: 'fixture-creation-four', phase: 'start' })
  usage.launch({ id: 'fixture-creation-four', phase: 'created', agent: 'timed-agent' })
  usage.launchState('timed-agent', 'failed', 'PRIVATE_CANARY' as never)
  await flush()
  expect(totals()).toMatchObject({ launch_created: 4, launch_late_failed: 3, launch_late_failed_code_engine_did_not_start: 1,
    launch_late_failed_code_start_timeout: 1, launch_late_failed_code_unlisted: 1 })
  expect(totals().launch_failed).toBeUndefined()
  expect(JSON.stringify(sent) + readFileSync(file, 'utf8')).not.toContain('CANARY')
})

it('watches a created launch\'s agent for a bounded time, and not past an opt-out', async () => {
  await usage.sync()
  usage.launch({ id: ID, phase: 'start' }); usage.launch({ id: ID, phase: 'created', agent: 'slow-agent' })
  now += 15 * 60_000; await usage.sync()
  usage.launchState('slow-agent', 'failed', 'start_timeout')
  usage.launch({ id: 'fixture-creation-two', phase: 'start' }); usage.launch({ id: 'fixture-creation-two', phase: 'created', agent: 'kept-agent' })
  enabled = false; await usage.sync(); enabled = true; await usage.sync()
  usage.launchState('kept-agent', 'failed', 'start_timeout')
  await flush()
  expect(totals().launch_late_failed).toBeUndefined()
})

it('counts an installation\'s first launch by its engine and, for Claude Code or Codex, whether it was signed in, once', async () => {
  await usage.stop()
  const engineSignedIn = vi.fn(async (engine: 'claude' | 'codex') => engine === 'claude')
  usage = createProductUsage({ file, now: () => now, request, engineSignedIn })
  await usage.sync()
  usage.launch({ id: ID, phase: 'start', engine: 'claude' })
  usage.launch({ id: 'fixture-creation-two', phase: 'start', engine: 'codex' })
  await vi.waitFor(() => expect(engineSignedIn).toHaveBeenCalledOnce())
  await flush()
  expect(totals()).toMatchObject({ first_launch_installations: 1, first_launch_engine_claude: 1, first_launch_claude_signed_in: 1 })
  expect(Object.keys(totals()).filter(name => name.startsWith('first_launch_') && !name.includes('_24h_')).sort())
    .toEqual(['first_launch_claude_signed_in', 'first_launch_engine_claude', 'first_launch_installations'])

  for (const [engine, answer, counted] of [['codex', null, 'first_launch_codex_unknown'], ['codex', false, 'first_launch_codex_signed_out'],
    ['claude', 'throws', 'first_launch_claude_unknown']] as const) {
    await usage.stop(); rmSync(file, { force: true }); sent = []
    const check = vi.fn(async () => { if (answer === 'throws') throw new Error('PRIVATE_CANARY'); return answer })
    usage = createProductUsage({ file, now: () => now, request, engineSignedIn: check })
    await usage.sync(); usage.launch({ id: ID, phase: 'start', engine })
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce())
    await flush()
    expect(totals()).toMatchObject({ [`first_launch_engine_${engine}`]: 1, [counted]: 1 })
  }
  // Another engine, or none named: its name only, and no look at any account.
  for (const engine of ['opencode', 'cursor', undefined] as const) {
    await usage.stop(); rmSync(file, { force: true }); sent = []
    const check = vi.fn(async () => true)
    usage = createProductUsage({ file, now: () => now, request, engineSignedIn: check })
    await usage.sync(); usage.launch({ id: ID, phase: 'start', engine: engine as never })
    await flush()
    expect(totals()).toMatchObject({ [`first_launch_engine_${engine === 'opencode' ? 'opencode' : 'other'}`]: 1 })
    expect(check).not.toHaveBeenCalled()
  }
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
})

it('drops a first launch\'s account answer that comes after the choice changed', async () => {
  await usage.stop()
  let answer!: (value: boolean) => void
  usage = createProductUsage({ file, now: () => now, request, engineSignedIn: () => new Promise(resolve => { answer = resolve }) })
  await usage.sync(); usage.launch({ id: ID, phase: 'start', engine: 'codex' })
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
  revision = 1; await usage.sync()
  answer(true); await flush()
  expect(totals().first_launch_codex_signed_in).toBeUndefined()
})

it('writes a clean exit before stop() returns: a collector started next on its file sees no unclean restart', async () => {
  await usage.stop()
  usage = createProductUsage({ file, now: () => now, request, context: CLI })
  await usage.sync()
  expect(JSON.parse(readFileSync(file, 'utf8')).health.cleanExit).toBe(false)
  // Not awaited, as the gateway's stop never waited for it, and its process exited next.
  void usage.stop()
  expect(JSON.parse(readFileSync(file, 'utf8')).health.cleanExit).toBe(true)
  usage = createProductUsage({ file, now: () => now, request, context: CLI })
  await flush()
  expect(totals().health_cli_unclean_restart).toBeUndefined()
  expect(totals().health_cli_install_unknown).toBe(2)
})

it('does not let a write already on its way put an older state over the clean exit', async () => {
  await usage.stop()
  let release: (() => void) | undefined, block = false
  usage = createProductUsage({ file, now: () => now, request, context: CLI, write: async (target, data) => {
    if (block) await new Promise<void>(resolve => { release = resolve })
    writeFileSync(target, data)
  } })
  await usage.sync()
  block = true
  usage.counter('create_requests')
  const flushing = usage.sync()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const stopped = usage.stop()
  expect(JSON.parse(readFileSync(file, 'utf8')).health.cleanExit).toBe(true)
  release!()
  await stopped; await flushing
  expect(JSON.parse(readFileSync(file, 'utf8')).health.cleanExit).toBe(true)
  usage = createProductUsage({ file, now: () => now, request, context: CLI })
  await flush()
  expect(totals().health_cli_unclean_restart).toBeUndefined()
})

it('counts a collector that was killed, without stop(), as exactly one unclean restart', async () => {
  await usage.stop()
  usage = createProductUsage({ file, now: () => now, request, context: CLI, random: () => 0.999 })
  await usage.sync()
  // Killed: no stop(), nothing written after this.
  usage = createProductUsage({ file, now: () => now, request, context: CLI })
  await usage.sync(); await usage.stop()
  usage = createProductUsage({ file, now: () => now, request, context: CLI })
  await flush()
  expect(totals().health_cli_unclean_restart).toBe(1)
})

it('stops once: a second stop writes nothing over the first one\'s final state', async () => {
  await usage.sync(); usage.observe('turn_started', 'a', false); retry = true; await usage.sync()
  await usage.stop(true)
  expect(await usage.stop()).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pending: null, days: {} })
})

describe('when reports go', () => {
  const T0 = Date.parse('2026-10-16T09:45:00Z')
  const at = (ms: number) => T0 + ms
  let posts: number[], answers: Array<{ status: number; body: Record<string, unknown>; retryAfterMs?: number }>
  const start = (random: () => number) => {
    usage = createProductUsage({ file, now: () => Date.now(), request, random,
      write: async (target, data) => { writeFileSync(target, data) } })
  }
  beforeEach(async () => {
    await usage.stop()
    vi.useFakeTimers({ now: T0 })
    posts = []; answers = []
    request.mockImplementation(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return { status: 200, body: { data: { enabled: true, revision: 0 } } }
      posts.push(Date.now()); sent.push(structuredClone(body))
      return answers.shift() ?? { status: 200, body: { data: { accepted: true } } }
    })
  })
  afterEach(() => { vi.useRealTimers() })

  it.each([[0, 10_000], [0.5, 35_000], [0.99999, 59_999]])('sends the first report a random 10 to 60 seconds after the gateway starts (%s)', async (r, first) => {
    // What the last run left to send, which a gateway started by a release used to send that same second.
    writeFileSync(file, JSON.stringify({ revision: 0, days: { '2026-10-16': { search_requests: 1 } } }))
    start(() => r)
    // The gateway's own first read: the choice, so collection starts, and no report.
    await usage.sync(false); usage.counter('search_requests')
    expect(posts).toEqual([])
    await vi.advanceTimersByTimeAsync(first - 1)
    expect(posts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(posts).toEqual([at(first)])
  })

  it('spreads the later ticks across 45 to 75 seconds', async () => {
    const values = [0, 0, 0.5, 0.99999]
    start(() => values.shift() ?? 0)
    const reads: number[] = []
    const answer = request.getMockImplementation()!
    request.mockImplementation(async (method, path, body) => { if (method === 'GET') reads.push(Date.now()); return answer(method, path, body) })
    await usage.sync(false)
    await vi.advanceTimersByTimeAsync(200_000)
    // The gateway's own read, then a tick 10 s on (the first report's), then 45, 60 and 74.999 s apart.
    expect(reads).toEqual([at(0), at(10_000), at(55_000), at(115_000), at(189_999)])
  })

  it('backs off a busy backend, longer each time and at most half an hour, counting each attempt as before', async () => {
    start(() => 0.5)
    await usage.sync(false); usage.counter('search_requests')
    answers = Array.from({ length: 12 }, () => ({ status: 429, body: { error: { code: 'USAGE_BUSY' } } }))
    await vi.advanceTimersByTimeAsync(3 * 3600_000)
    // Ticks every 60 s here (0.5 of 45 to 75) and half of a ceiling that doubles from two minutes to the half
    // hour: twelve refusals in 2.3 hours, where a report each minute made 135 attempts.
    const gaps = posts.slice(1, 13).map((t, i) => t - posts[i])
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000, ...Array(8).fill(900_000)])
    // Answered again: a report each tick, and each refused attempt counted once.
    const attempts = posts.length
    usage.counter('search_requests'); await vi.advanceTimersByTimeAsync(60_000)
    usage.counter('search_requests'); await vi.advanceTimersByTimeAsync(60_000)
    expect(posts.length).toBe(attempts + 2)
    expect(totals().health_cli_report_rejected).toBe(12)
    expect(totals().health_cli_report_failure_rate_limited).toBe(12)
  })

  it.each([[503, 'USAGE_WRITE_CONFLICT'], [504, 'BACKEND_TIMEOUT'], [502, 'BACKEND_UNREACHABLE']])('backs off a %i (%s) too', async (status, code) => {
    start(() => 0.5)
    await usage.sync(false); usage.counter('search_requests')
    answers = [{ status, body: { error: { code } } }, { status, body: { error: { code } } }]
    await vi.advanceTimersByTimeAsync(35_000 + 60_000 + 60_000)
    expect(posts).toEqual([at(35_000), at(95_000)])
  })

  it('backs off a report whose request threw, and not one the backend refused as invalid', async () => {
    start(() => 0.5)
    await usage.sync(false); usage.counter('search_requests')
    const choice = async () => ({ status: 200, body: { data: { enabled: true, revision: 0 } } })
    const thrown = async () => { posts.push(Date.now()); throw new Error('PRIVATE_CANARY') }
    request.mockImplementationOnce(choice).mockImplementationOnce(thrown).mockImplementationOnce(choice).mockImplementationOnce(thrown)
    await vi.advanceTimersByTimeAsync(95_000)
    expect(posts).toEqual([at(35_000), at(95_000)])
    // Two in a row: up to four minutes, here two, so the tick at 155 s sends nothing.
    answers = [{ status: 400, body: {} }]
    await vi.advanceTimersByTimeAsync(120_000)
    expect(posts).toEqual([at(35_000), at(95_000), at(215_000)])
    // The backend's answer, if a refusal: the next report goes at the next tick.
    usage.counter('search_requests'); await vi.advanceTimersByTimeAsync(60_000)
    expect(posts).toEqual([at(35_000), at(95_000), at(215_000), at(275_000)])
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_CANARY')
  })

  it('waits at least what Retry-After asks, held to the half-hour ceiling', async () => {
    start(() => 0)
    await usage.sync(false); usage.counter('search_requests')
    answers = [{ status: 429, body: {}, retryAfterMs: 10 * 60_000 }, { status: 503, body: {}, retryAfterMs: 5 * 3600_000 }]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(posts).toEqual([at(10_000)])
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    expect(posts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toBe(at(640_000))
    // Five hours asked: held to the half hour.
    await vi.advanceTimersByTimeAsync(at(640_000 + 30 * 60_000) - 1 - Date.now())
    expect(posts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(posts).toEqual([at(10_000), at(640_000), at(2_440_000)])
  })

  it('stops ticking once stopped', async () => {
    start(() => 0)
    await usage.sync(false); usage.counter('search_requests')
    await usage.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
