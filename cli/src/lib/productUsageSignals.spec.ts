import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { failureKind, launchErrorCode, productObservation, productUsageIntent, productUsageLaunch, productUsageRequest, productUsageSource } from './productUsageSignals.js'
import { LAUNCH_ERROR_CODES, PRODUCT_USAGE_FLOWS, PRODUCT_USAGE_METRICS, PRODUCT_USAGE_SETUP_METRICS } from './productUsageContract.js'
import { HEALTH_MEASURES } from './productHealthContract.js'

it('separates automated polling, tool and app RPCs without inspecting error objects or content', () => {
  const emit = vi.fn()
  productUsageRequest('models_list', emit, Date.now, 'app')(undefined, undefined, false)
  productUsageRequest('models_list', emit, Date.now, 'tool')(undefined, undefined, false)
  productUsageRequest('agent_resume', emit, Date.now, 'tool')('AGENT_NOT_FOUND', 'failed', false)
  productUsageRequest('agent_close', emit, Date.now, 'app')(undefined, 'cancelled', false)
  const secret = { toString() { throw Error('PRIVATE') } }
  expect(() => productUsageRequest('agent_restart', emit, Date.now, 'unknown')(secret, 'failed', false)).not.toThrow()
  expect(emit.mock.calls.flat()).toEqual(expect.arrayContaining(['request_automatic_model_list_ok', 'request_tool_resume_error_not_found', 'request_app_close_cancelled', 'request_unknown_restart_error_other']))
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE')
  expect(emit.mock.calls.flat()).toContain('request_tool_model_list_ok')
})
it('tells the phone apart from the browser only by its own word, and never a local or device client', () => {
  expect(productUsageSource(true, true, null, {})).toBe('tool')
  expect(productUsageSource(true, false, null, { usageSurface: 'phone' })).toBe('app')
  expect(productUsageSource(false, false, 'web', { usageSurface: 'phone' })).toBe('phone')
  expect(productUsageSource(false, false, 'web', {})).toBe('app')
  expect(productUsageSource(false, false, 'web', undefined)).toBe('app')
  expect(productUsageSource(false, false, 'web', { usageSurface: 'PRIVATE_LABEL' })).toBe('app')
  expect(productUsageSource(false, false, 'device', { usageSurface: 'phone' })).toBe('unknown')
  expect(productUsageSource(false, false, null, { usageSurface: 'phone' })).toBe('unknown')
})
it('counts what a person on the phone asked for as the phone\'s, and its polls as automatic', () => {
  const emit = vi.fn()
  productUsageRequest('agent_create', emit, Date.now, 'phone')(undefined, 'created', true)
  productUsageRequest('agent_resume', emit, Date.now, 'phone')('AGENT_BUSY', 'failed', false)
  productUsageRequest('agent_recent', emit, Date.now, 'phone')(undefined, undefined, false)
  productUsageRequest('models_list', emit, Date.now, 'phone')(undefined, undefined, false)
  const names = emit.mock.calls.flat()
  expect(names).toEqual(expect.arrayContaining(['request_phone_create_started', 'request_phone_create_ok',
    'request_phone_resume_error_other', 'request_phone_resume_reason_busy',
    'request_automatic_history_ok', 'request_automatic_model_list_ok']))
  expect(names).not.toContain('request_phone_history_ok')
  for (const name of names) expect(PRODUCT_USAGE_METRICS).toContain(name)
  const work = vi.fn()
  productUsageIntent('message', 'interactive', 'agent', 'phone', work)
  expect(work).toHaveBeenCalledWith({ id: 'agent', phase: 'work_requested', origin: 'interactive' })
})
it('requires an explicit composer marker for interactive work; raw terminal input is unclassified', () => {
  const emit = vi.fn()
  productUsageIntent('terminal_input', 'interactive', 'agent', 'app', emit)
  productUsageIntent('message', undefined, 'agent', 'app', emit)
  expect(emit).not.toHaveBeenCalled()
  productUsageIntent('message', 'interactive', 'agent', 'app', emit)
  expect(emit).toHaveBeenCalledWith({ id: 'agent', phase: 'work_requested', origin: 'interactive' })
  expect(() => productUsageIntent('message', undefined, 'agent', 'tool', () => { throw Error() })).not.toThrow()
})

it('distinguishes a pending launch from a launched harness, and counts replies once', () => {
  let now = 0
  const emit = vi.fn(), done = productUsageRequest('agent_create', emit, () => now)
  now = 12_000; done(undefined, 'pending', false); done(undefined, 'created', true)
  expect(emit.mock.calls.flat()).toEqual(['create_requests', 'create_pending', 'create_10s_to_1m'])
})
it('maps known failures and never emits raw or unknown error strings', () => {
  const emit = vi.fn()
  productUsageRequest('agent_create', emit)('ENGINE_UNAVAILABLE', undefined, false)
  productUsageRequest('agent_restart', emit)('PRIVATE_ERROR_WITH_PATH', 'failed', false)
  expect(emit.mock.calls.flat()).toContain('create_error_setup')
  expect(emit.mock.calls.flat()).toContain('restart_error_other')
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_')
})
it('ignores arbitrary RPC names and status polling and survives unavailable reporting', () => {
  const emit = vi.fn()
  for (const type of ['PRIVATE_METHOD', 'agent_create_status', 'text_delta']) productUsageRequest(type, emit)(undefined, undefined, true)
  expect(emit).not.toHaveBeenCalled()
  expect(() => productUsageRequest('agent_create', () => { throw Error('offline') })(undefined, 'created', true)).not.toThrow()
})

it('reduces durable launch statuses to fixed categories without forwarding error or hold text', () => {
  const emit = vi.fn(), id = 'fixture-creation-one'
  productUsageLaunch('agent_create', id, emit)(undefined, 'pending', false, 'install')
  productUsageLaunch('agent_create_status', id, emit)('PRIVATE_CANARY', 'failed', false, 'PRIVATE_CANARY')
  expect(emit.mock.calls.flat()).toEqual([{ id, phase: 'start', engine: 'other' }, { id, phase: 'pending', wait: 'install' },
    { id, phase: 'failed', failure: 'other', code: 'unlisted' }])
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_CANARY')
})

it.each([
  ['INVALID_PROMPT', 'invalid_prompt'], ['ENGINE_INSTALL_FAILED', 'engine_install_failed'], ['CREATION_STORAGE_FAILED', 'creation_storage_failed'],
  ['PRIVATE_ERROR_WITH_PATH', 'unlisted'], ['__proto__', 'unlisted'], ['UNLISTED', 'unlisted'], ['NONE', 'unlisted'],
  ['INTERNAL'.repeat(20), 'unlisted'], [undefined, 'none'], [{ code: 'INVALID_PROMPT' }, 'none'],
])('names the code of an `other` launch failure %s as %s, from the fixed list only', (error, code) => {
  expect(launchErrorCode(error)).toBe(code)
  const emit = vi.fn()
  productUsageLaunch('agent_create_status', 'fixture-creation-one', emit)(error, 'failed', false, undefined)
  expect(emit).toHaveBeenCalledWith({ id: 'fixture-creation-one', phase: 'failed', failure: 'other', code })
  expect(LAUNCH_ERROR_CODES).toContain(code)
})
it('names no code for a failure of a fixed kind, which its kind already says', () => {
  const emit = vi.fn()
  productUsageLaunch('agent_create_status', 'fixture-creation-one', emit)('TMUX_UNAVAILABLE', 'failed', false, undefined)
  expect(emit).toHaveBeenCalledWith({ id: 'fixture-creation-one', phase: 'failed', failure: 'setup' })
})

it('counts the code of an `other` create or resume refusal beside its kind, so each code family adds up to its `_other`', () => {
  const emit = vi.fn()
  productUsageRequest('agent_create', emit, () => 0, 'app')('PROMPT_TOO_LONG', undefined, false)
  productUsageRequest('agent_create', emit, () => 0, 'app')('PRIVATE_ERROR_WITH_PATH', 'failed', false)
  productUsageRequest('agent_create', emit, () => 0, 'app')(undefined, 'failed', false)
  productUsageRequest('agent_create', emit, () => 0, 'app')('INVALID_CWD', undefined, false)
  productUsageRequest('agent_resume', emit, () => 0, 'app')('SESSION_NOT_FOUND', 'failed', false)
  productUsageRequest('agent_resume', emit, () => 0, 'app')(undefined, undefined, false, false)
  // Other actions keep their kinds only.
  productUsageRequest('agent_restart', emit, () => 0, 'app')('RESTART_FAILED', 'failed', false)
  const names: string[] = emit.mock.calls.flat()
  const family = (prefix: string) => names.filter(name => name.startsWith(prefix)).sort()
  expect(family('create_error_code_')).toEqual(['create_error_code_none', 'create_error_code_prompt_too_long', 'create_error_code_unlisted'])
  expect(names.filter(name => name === 'create_error_other')).toHaveLength(3)
  expect(family('resume_error_code_')).toEqual(['resume_error_code_none', 'resume_error_code_session_not_found'])
  expect(names.filter(name => name === 'resume_error_other')).toHaveLength(2)
  expect(names.some(name => name.startsWith('restart_error_code_'))).toBe(false)
  for (const name of names) expect(PRODUCT_USAGE_METRICS).toContain(name)
  expect(JSON.stringify(names)).not.toContain('PRIVATE_')
})

it('says which engine a new launch asked for, as a fixed name', () => {
  const emit = vi.fn()
  for (const engine of ['claude', 'codex', 'opencode', 'cursor', 'other', 'PRIVATE_ENGINE', undefined, { name: 'claude' }]) {
    productUsageLaunch('agent_create', 'fixture-creation-one', emit, engine)
  }
  expect(emit.mock.calls.map(([signal]) => signal.engine)).toEqual(['claude', 'codex', 'opencode', 'other', 'other', 'other', 'other', 'other'])
  // A status poll is no new launch: it says no engine.
  emit.mockClear(); productUsageLaunch('agent_create_status', 'fixture-creation-one', emit, 'claude')
  expect(emit).not.toHaveBeenCalled()
})

it('hands a created launch\'s starting agent on for its start, or says its start had already failed', () => {
  const emit = vi.fn(), id = 'fixture-creation-one'
  const done = (agent: unknown) => productUsageLaunch('agent_create_status', id, emit)(undefined, 'created', agent, undefined)
  done({ id: 'fixture-agent', launch: { state: 'starting' }, name: 'PRIVATE_CANARY' })
  done({ id: 'fixture-agent', launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'PRIVATE_CANARY' } })
  done({ id: 'fixture-agent', launch: { state: 'failed', error: 'PRIVATE_CANARY' } })
  done({ id: 'fixture-agent', launch: { state: 'ready' } })
  done({ id: 'x'.repeat(257), launch: { state: 'starting' } })
  done(true)
  expect(emit.mock.calls.flat()).toEqual([
    { id, phase: 'created', agent: 'fixture-agent' },
    { id, phase: 'created', late: true, code: 'engine_did_not_start' },
    { id, phase: 'created', late: true, code: 'unlisted' },
    { id, phase: 'created' }, { id, phase: 'created' }, { id, phase: 'created' },
  ])
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_CANARY')
})

it('keeps every refusal core/agents can answer named: in a fixed kind, or in the code list', () => {
  // A code missing from both reads as `unlisted` and says nothing again (production counters, 2026-10-16).
  const root = fileURLToPath(new URL('../core/agents/', import.meta.url))
  const codes = new Set<string>()
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue
    for (const match of readFileSync(join(root, name), 'utf8').matchAll(/error: '([A-Z][A-Z0-9_]*)'/g)) codes.add(match[1])
  }
  expect(codes.size).toBeGreaterThan(40)
  const unnamed = [...codes].filter(code => failureKind(code) === 'other' && launchErrorCode(code) === 'unlisted')
  expect(unnamed, 'add each to LAUNCH_ERROR_CODES (lib/productUsageContract.ts and its backend copy)').toEqual([])
  // The codes the new-pane watcher sets after a create replied, which no `error: '…'` literal names.
  for (const code of ['ENGINE_DID_NOT_START', 'ENGINE_NOT_INSTALLED', 'START_TIMEOUT']) expect(launchErrorCode(code)).toBe(code.toLowerCase())
})


it('observes Store, search and model operations without their arguments and rejects explicit false outcomes', () => {
  const emit = vi.fn()
  productUsageRequest('dsh_install', emit)(undefined, undefined, false, false)
  productUsageRequest('session_search', emit)(undefined, undefined, false)
  productUsageRequest('grid_fleet_model_download', emit)('TIMEOUT', undefined, false)
  expect(emit.mock.calls.flat()).toEqual(expect.arrayContaining([
    'store_install_requests', 'store_install_failed', 'search_ok', 'model_download_error_unavailable',
  ]))
  const clock = vi.fn()
  productUsageRequest('terminal_input', emit, clock)
  expect(clock).not.toHaveBeenCalled()
})

it('marks a Store or model list a person opened, and only those', () => {
  const emit = vi.fn()
  productUsageRequest('dsh_list', emit, Date.now, 'app', true)(undefined, undefined, false)
  productUsageRequest('grid_models_list', emit, Date.now, 'app', true)(undefined, undefined, false)
  expect(emit.mock.calls.flat()).toEqual(expect.arrayContaining(['store_list_user_requests', 'model_list_user_requests']))
  emit.mockClear()
  // The Store's minute refresh, the pickers and the previews send no flag; history has no person behind it.
  productUsageRequest('dsh_list', emit)(undefined, undefined, false)
  productUsageRequest('agent_recent', emit, Date.now, 'app', true)(undefined, undefined, false)
  productUsageRequest('session_tail', emit, Date.now, 'app', true)(undefined, undefined, false)
  expect(emit.mock.calls.flat().filter(m => String(m).includes('_user_'))).toEqual([])
})

it.each([
  ['TMUX_UNAVAILABLE', 'runtime_unavailable'], ['NATIVE_LAUNCH_HELD', 'runtime_unavailable'],
  ['AGENT_NOT_FOUND', 'saved_state_missing'], ['RESUME_UNAVAILABLE', 'saved_state_missing'],
  ['CWD_NOT_FOUND', 'project_missing'], ['INVALID_DSH', 'harness_missing'],
  ['GRID_CREDENTIAL_REQUIRED', 'credentials_missing'], ['AGENT_BUSY', 'busy'],
  ['RESUME_PREPARATION_FAILED', 'preparation_failed'], ['RESUME_FAILED', 'launch_failed'],
  ['INVALID_PERMISSION_MODE', 'invalid'], ['PRIVATE_ERROR_WITH_PATH', 'other'], ['__proto__', 'other'],
  // Fell to `other` until 2026-10-16's counters showed them.
  ['ENGINE_DID_NOT_START', 'launch_failed'], ['ENGINE_NOT_INSTALLED', 'launch_failed'], ['START_TIMEOUT', 'launch_failed'],
  ['DELETE_IN_PROGRESS', 'busy'], ['MISSING_AGENT_ID', 'invalid'],
])('reduces resume condition %s to an approved counter without retaining it', (error, reason) => {
  const emit = vi.fn(), done = productUsageRequest('agent_resume', emit, () => 0, 'app')
  done(error, 'failed', false); done(error, 'failed', false)
  const names = emit.mock.calls.flat()
  expect(names.filter(name => name.startsWith('request_app_resume_reason_'))).toEqual([`request_app_resume_reason_${reason}`])
  expect(names).toContain('request_app_resume_failed')
  for (const name of names) expect(PRODUCT_USAGE_METRICS).toContain(name)
  expect(JSON.stringify(names)).not.toContain(error)
})
it.each([
  ['RESUME_UNCONFIRMED', undefined, 'unconfirmed', 'unknown'],
  [undefined, 'unconfirmed', 'unconfirmed', 'unknown'],
  ['AGENT_CHANGED', 'failed', 'changed', 'cancelled'],
])('does not call an unverified or superseded resume a failure', (error, state, reason, result) => {
  const emit = vi.fn()
  productUsageRequest('agent_resume', emit, () => 0, 'tool')(error, state, false)
  expect(emit.mock.calls.flat()).toEqual(['resume_requests', 'request_tool_resume_started',
    `request_tool_resume_reason_${reason}`, 'resume_unknown', `request_tool_resume_${result}`, 'resume_under_1s'])
})
it('never coerces private reply values and leaves successful resumes without a diagnostic', () => {
  const emit = vi.fn(), privateValue = { toString() { throw Error('PRIVATE') } }
  expect(() => productUsageRequest('agent_resume', emit, () => 0, 'unknown')(privateValue, privateValue, false)).not.toThrow()
  expect(emit.mock.calls.flat()).toContain('request_unknown_resume_reason_other')
  emit.mockClear()
  productUsageRequest('agent_resume', emit, () => 0, 'app')(undefined, 'created', true)
  expect(emit.mock.calls.flat()).toContain('request_app_resume_ok')
  expect(emit.mock.calls.flat().some(name => name.includes('_reason_'))).toBe(false)
})

it('names every flow and health measure for hn, and no signed-out setup counter', () => {
  const metrics = new Set<string>(PRODUCT_USAGE_METRICS)
  for (const flow of PRODUCT_USAGE_FLOWS) for (const measure of ['started', 'ok', 'failed', 'cancelled', 'unknown', 'under_1s', 'over_1m']) {
    expect(metrics.has(`ui_tui_${flow}_${measure}`), `${flow}_${measure}`).toBe(true)
  }
  for (const measure of HEALTH_MEASURES) expect(metrics.has(`health_tui_${measure}`), measure).toBe(true)
  expect(PRODUCT_USAGE_SETUP_METRICS.some(metric => metric.includes('_tui_'))).toBe(false)
})

it('reduces hn\'s observations to the Desktop\'s flow and milestone counters, and nothing else', () => {
  // Started when it begins, as the Desktop's `begin()` counts it; the outcome alone when it ends.
  expect(productObservation({ flow: 'computer_link' })).toEqual(['ui_tui_computer_link_started'])
  expect(productObservation({ flow: 'computer_link', outcome: 'ok', durationMs: 999 }))
    .toEqual(['ui_tui_computer_link_ok', 'ui_tui_computer_link_under_1s'])
  expect(productObservation({ durationMs: 1000, outcome: 'failed', flow: 'remote_connect' }))
    .toEqual(['ui_tui_remote_connect_failed', 'ui_tui_remote_connect_1s_to_10s'])
  expect(productObservation({ flow: 'resume_recovery', outcome: 'cancelled', durationMs: 59_999 })[1]).toBe('ui_tui_resume_recovery_10s_to_1m')
  expect(productObservation({ flow: 'app_start', outcome: 'unknown', durationMs: 60_000 })[1]).toBe('ui_tui_app_start_over_1m')
  expect(productObservation({ measure: 'funnel_first_work' })).toEqual(['health_tui_funnel_first_work'])
  expect(productObservation({ measure: 'first_response_1m_to_5m' })).toEqual(['health_tui_first_response_1m_to_5m'])
  const invalid = [null, undefined, 'sign_in', [], {}, { flow: 'PRIVATE_CANARY', outcome: 'ok', durationMs: 1 },
    { flow: 'sign_in', outcome: 'started', durationMs: 1 }, { flow: 'sign_in', outcome: 'PRIVATE_CANARY', durationMs: 1 },
    ...[-1, NaN, Infinity, '1', null].map(durationMs => ({ flow: 'sign_in', outcome: 'ok', durationMs })),
    { flow: 'sign_in', outcome: 'ok' }, { flow: 'sign_in', outcome: 'ok', durationMs: 1, path: 'PRIVATE_CANARY' },
    { flow: 'sign_in', durationMs: 1 }, { flow: 'sign_in', path: 'PRIVATE_CANARY' }, { flow: 'PRIVATE_CANARY' }, { flow: 1 },
    { measure: 'PRIVATE_CANARY' }, { measure: 'tui_opens' }, { measure: 'funnel_first_work', agentId: 'PRIVATE_CANARY' },
    { measure: 'funnel_first_work', flow: 'sign_in', outcome: 'ok', durationMs: 1 }, { flow: 'toString', outcome: 'ok', durationMs: 1 },
    { measure: 'constructor' }]
  for (const value of invalid) expect(productObservation(value), JSON.stringify(value)).toEqual([])
  const all = new Set<string>(PRODUCT_USAGE_METRICS)
  for (const flow of PRODUCT_USAGE_FLOWS) {
    for (const metric of productObservation({ flow })) expect(all.has(metric), metric).toBe(true)
    for (const outcome of ['ok', 'failed', 'cancelled', 'unknown']) {
      for (const metric of productObservation({ flow, outcome, durationMs: 0 })) expect(all.has(metric), metric).toBe(true)
    }
  }
})
