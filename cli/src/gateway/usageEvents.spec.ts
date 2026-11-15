/**
 * The usage counters reach the backend with the same names and totals now that the gateway names them: the core's raw
 * outcomes (core/usageOutcomes.ts) counted here (gateway/usageEvents.ts) against the reductions as the core ran them
 * before (backendSocket.ts, until this change), side by side, request by request, and then what each recorder sends the
 * backend (gateway/productUsage.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createUsageOutcomes } from '../core/usageOutcomes.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { messageReceipt, productObservation, productUsageIntent, productUsageLaunch, productUsageRequest, productUsageSource,
  type ProductUsageLaunchSignal } from '../lib/productUsageSignals.js'
import type { MessageOutcome } from '../lib/sessionInput.js'
import { createProductUsage } from './productUsage.js'
import { countUsage } from './usageEvents.js'

type From = { local: boolean; tool: boolean; role: string | null }
/** A request, who sent it, then what happened to it: a reply (and the milliseconds before it), or a message's outcome. */
type Case = [string, Record<string, unknown>, From, Array<{ reply: Record<string, unknown>; after: number } | { outcome: MessageOutcome; after: number }>]

const APP: From = { local: true, tool: false, role: null }
const TOOL: From = { local: true, tool: true, role: null }
const WEB: From = { local: false, tool: false, role: 'web' }
const DEVICE: From = { local: false, tool: false, role: 'device' }
const id = (n: number) => `creation-${String(n).padStart(12, '0')}`
const frame = (agentId: string, launch?: Record<string, unknown>) => ({ id: agentId, name: 'PRIVATE', cwd: '/PRIVATE', ...(launch ? { launch } : {}) })

const CASES: Case[] = [
  ['agent_create', { creationId: id(1), engine: 'claude', cwd: '/PRIVATE' }, APP, [{ reply: { state: 'created', agent: frame('a1', { state: 'starting' }) }, after: 400 }]],
  ['agent_create', { creationId: id(2), engine: 'codex', startedBy: 'agent', startedByHachi: true }, APP, [{ reply: { error: 'SPAWN_FAILED', state: 'failed' }, after: 3_000 }]],
  ['agent_create', { creationId: id(3), engine: 'other-engine', startedBy: 'agent' }, TOOL, [{ reply: { error: 'SESSION_IN_HARNESS' }, after: 20 }]],
  ['agent_create', { creationId: id(4), engine: 'opencode', usageSurface: 'phone' }, WEB, [{ reply: { state: 'pending', held: { service: 'install' } }, after: 50 }]],
  ['agent_create_status', { creationId: id(4) }, WEB, [{ reply: { state: 'created', agent: frame('a4', { state: 'failed', error: 'ENGINE_DID_NOT_START' }) }, after: 70_000 }]],
  ['agent_create', { creationId: id(5), engine: 'claude' }, APP, [{ reply: { state: 'pending', held: { service: 'models' } }, after: 5 }, { reply: { state: 'created', agent: frame('a5') }, after: 15_000 }]],
  ['agent_create_cancel', { creationId: id(5) }, APP, [{ reply: { state: 'cancelled' }, after: 5 }]],
  ['agent_create', { creationId: id(6), engine: 'claude' }, APP, [{ reply: { error: `PRIVATE_${'x'.repeat(100)}` }, after: 5 }]],
  ['agent_create', { creationId: 'too-short', engine: 'claude' }, APP, [{ reply: { failure: { code: 'WORKTREE_FAILED', reason: 'PRIVATE' } }, after: 5 }]],
  ['agent_resume', { agentId: 'a1', usageSurface: 'phone' }, WEB, [{ reply: { ok: false, error: 'RESUME_PREPARATION_FAILED', reason: 'changed_during', detail: 'PRIVATE' }, after: 900 }]],
  ['agent_resume', { agentId: 'a1' }, APP, [{ reply: { failure: { code: 'RESUME_PREPARATION_FAILED', reason: 'PRIVATE_kind' } }, after: 10 }]],
  ['agent_resume', { agentId: 'a1' }, APP, [{ reply: { error: 'AGENT_CHANGED' }, after: 10 }]],
  ['agent_resume', { agentId: 'a1' }, APP, [{ reply: { state: 'unconfirmed' }, after: 10 }]],
  ['agent_resume', { agentId: 'a1' }, APP, [{ reply: { agent: frame('a1') }, after: 10 }]],
  ['agent_resume', { agentId: 'a1' }, APP, [{ reply: {}, after: 10 }]],
  ['agent_delete', { agentId: 'a1', usageSurface: 'phone' }, WEB, [{ reply: { error: 'STOP_UNCONFIRMED' }, after: 10 }]],
  ['agent_delete', { agentId: 'a1' }, APP, [{ reply: { error: { code: 'PRIVATE' } }, after: 10 }]],
  ['agent_restart', { agentId: 'a1', usageSurface: 'phone' }, WEB, [{ reply: { error: 'TMUX_UNAVAILABLE' }, after: 10 }]],
  ['agent_retarget', { agentId: 'a1' }, APP, [{ reply: { state: 'preparing' }, after: 10 }]],
  ['agent_fork', { agentId: 'a1' }, APP, [{ reply: { agent: frame('a9') }, after: 10 }]],
  ['agent_close', { agentId: 'a1' }, APP, [{ reply: { ok: true }, after: 10 }]],
  ['agent_recent', { agentId: 'a1' }, DEVICE, [{ reply: {}, after: 10 }]],
  ['session_tail', { sessionId: 's1', usageSurface: 'phone' }, WEB, [{ reply: { error: 'NOT_INDEXED' }, after: 10 }]],
  ['session_search', { query: 'PRIVATE' }, TOOL, [{ reply: {}, after: 10 }]],
  ['dsh_list', { userAction: true }, APP, [{ reply: {}, after: 10 }]],
  ['dsh_install', { id: 'x' }, APP, [{ reply: { error: 'CLONE_FAILED' }, after: 61_000 }]],
  ['dsh_update', { id: 'x' }, APP, [{ reply: { error: 'SOMETHING_NEW' }, after: 10 }]],
  ['dsh_remove', { id: 'x' }, APP, [{ reply: { error: 'DSH_BUSY' }, after: 10 }]],
  ['models_list', { usageSurface: 'phone', userAction: true }, WEB, [{ reply: {}, after: 10 }]],
  ['grid_models_list', {}, APP, [{ reply: { error: 'TIMEOUT' }, after: 10 }]],
  ['grid_fleet_model_download', {}, APP, [{ reply: { error: 'GRID_UNAVAILABLE' }, after: 10 }]],
  ['browser_open', { url: 'https://PRIVATE' }, APP, [{ reply: { error: 'NOT_ALLOWED' }, after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE', usageIntent: 'interactive' }, APP, [{ outcome: 'started', after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE', usageSurface: 'phone', usageIntent: 'interactive' }, WEB, [{ outcome: 'held', after: 10 }, { outcome: 'taken', after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE' }, TOOL, [{ outcome: 'ambiguous', after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE' }, APP, [{ outcome: 'cancelled', after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE' }, APP, [{ reply: { error: 'DELETE_IN_PROGRESS' }, after: 10 }, { outcome: 'started', after: 10 }]],
  ['message', { agentId: 'a1', content: 'PRIVATE' }, APP, [{ outcome: 'not_submitted', after: 10 }]],
  ['agents_list', {}, APP, [{ reply: {}, after: 10 }]],
]
const OBSERVED = [{ flow: 'remote_connect' }, { flow: 'remote_connect', outcome: 'failed', durationMs: 12_000 }, { measure: 'collector_days' },
  { flow: 'remote_connect', outcome: 'ok', durationMs: 5, extra: 1 }, { measure: 'PRIVATE' }]

/** What the core counted itself before this change, for each case: its reductions, run as backendSocket.ts ran them. */
function before(counter: (metric: ProductUsageMetric) => void, launch: (signal: ProductUsageLaunchSignal) => void): void {
  for (const [type, payload, from, steps] of CASES) {
    let at = 0
    const launchMeasured = productUsageLaunch(type, payload.creationId, launch, payload.engine, payload.startedBy === 'agent', payload.startedByHachi === true)
    const source = productUsageSource(from.local, from.tool, from.role, payload)
    const measured = productUsageRequest(type, counter, () => at, source, payload.userAction === true)
    productUsageIntent(type, payload.usageIntent, payload.agentId, source, launch)
    for (const step of steps) {
      at += step.after
      if ('outcome' in step) { messageReceipt(measured)(step.outcome); continue }
      const p = step.reply
      const failure = p.failure as { code?: unknown; reason?: unknown } | undefined
      measured(p.error ?? failure?.code, p.state, !!p.agent, p.ok, undefined, p.reason ?? failure?.reason)
      launchMeasured(p.error ?? failure?.code, p.state, p.agent, (p.held as { service?: unknown } | undefined)?.service)
    }
  }
  for (const payload of OBSERVED) for (const metric of productObservation(payload)) counter(metric)
}

/** The same cases now: the core tells them raw, and the gateway counts them, through the link as JSON. */
function after(counter: (metric: ProductUsageMetric) => void, launch: (signal: ProductUsageLaunchSignal) => void): void {
  let at = 0
  const usage = createUsageOutcomes({ send: (event) => countUsage(JSON.parse(JSON.stringify(event)), counter, launch), now: () => at })
  for (const [type, payload, from, steps] of CASES) {
    const measured = usage.request(type, payload, from)
    for (const step of steps) {
      at += step.after
      if ('outcome' in step) measured?.receipt(step.outcome)
      else measured?.answered(step.reply)
    }
  }
  for (const payload of OBSERVED) usage.observed(payload)
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** What a recorder sends the backend for the counts [count] makes, summed by name. */
async function reported(count: typeof before): Promise<Record<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-usage-events-'))
  dirs.push(dir)
  const sent: Array<{ counters: Record<string, number> }> = []
  const now = Date.parse('2026-11-15T10:00:00Z')
  const usage = createProductUsage({ file: join(dir, 'counts.json'), now: () => now, request: async (method, _path, body) => {
    if (method === 'GET') return { status: 200, body: { data: { enabled: true, revision: 0 } } }
    sent.push(structuredClone(body) as { counters: Record<string, number> })
    return { status: 200, body: { data: { accepted: true } } }
  } })
  await usage.sync()
  count((metric) => usage.counter(metric), (signal) => usage.launch(signal))
  await usage.sync()
  await usage.stop()
  const totals: Record<string, number> = {}
  for (const report of sent) for (const [name, n] of Object.entries(report.counters)) totals[name] = (totals[name] ?? 0) + n
  return totals
}

describe('the usage counters, named in the gateway', () => {
  it('are the names the core counted itself, in the same order, and the same launch signals', () => {
    const was = { counters: [] as string[], launches: [] as unknown[] }
    const now = { counters: [] as string[], launches: [] as unknown[] }
    before((metric) => { was.counters.push(metric) }, (signal) => { was.launches.push(signal) })
    after((metric) => { now.counters.push(metric) }, (signal) => { now.launches.push(signal) })
    expect(was.counters.length).toBeGreaterThan(150)
    expect(now).toEqual(was)
    expect(JSON.stringify(now)).not.toContain('PRIVATE')
  })

  it('reach the backend with the same names and totals', async () => {
    const was = await reported(before)
    const now = await reported(after)
    expect(Object.keys(was).length).toBeGreaterThan(50)
    expect(was).toMatchObject({ launch_started: 6, launch_created: 3, launch_refused: 1 })
    expect(now).toEqual(was)
  })
})
