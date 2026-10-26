import { screenFor } from '../engines/screens.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseAgentService, LEAD_PROTECTED_DETAIL, inspectCloseActivity as inspectCloseReading, type CloseActivity, type CloseAgentServiceDeps, type AgentCloseRequest } from './closeAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { findResumedTranscript } from './sessionRepair.js'
import { piSessionFolder } from '../engines/repairIdentities.js'

let row: RegisteredSession
let service: CloseAgentService
let deps: CloseAgentServiceDeps
let time: number
const request = (mode: AgentCloseRequest['mode'] = 'idle'): AgentCloseRequest => ({ agentId: row.agentId,
  sessionId: row.sessionId, createdAt: new Date(row.registeredAt).toISOString(), mode })
beforeEach(() => {
  time = 10_000
  row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%88' }], cwd: '/tmp' })!
  Object.assign(row, { sessionId: 'history', processIdentity: { pid: 777, startMarker: 'born', executable: 'codex' } })
  const home = join(env.ADAPTER_DATA_DIR, 'close-history', row.agentId)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  Object.assign(row, { codexHome: home, transcriptPath: join(home, 'sessions', 'history.jsonl') })
  writeFileSync(row.transcriptPath!, '{"history":"fixture"}\n')
  deps = { registry, now: () => time, activity: vi.fn(async (): Promise<CloseActivity> => 'idle'), checkpoint: vi.fn(async () => {}),
    changed: vi.fn(), stop: vi.fn(async (id, options) => {
      await options.checkpoint?.(row, 'before')
      await options.beforeStop?.(row)
      if (options.current?.() === false) throw new Error('cancelled')
      registry.removeAgent(id)
    }) }
  service = new CloseAgentService(deps)
})
afterEach(() => { service.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); for (const s of registry.list()) registry.removeAgent(s.agentId) })

it.each(['before', 'activity', 'checkpoint'] as const)('a Swarm close preserves a worker that stopped being Swarm-started at %s', async phase => {
  row.startedBy = 'agent'
  if (phase === 'before') row.startedBy = undefined
  if (phase === 'activity') vi.mocked(deps.activity).mockImplementation(async () => { row.startedBy = undefined; return 'idle' })
  if (phase === 'checkpoint') vi.mocked(deps.checkpoint).mockImplementation(async () => { row.startedBy = undefined })
  const guarded = { ...request('now'), onlyIfOriginalLaunch: true }
  expect(await service.request(guarded)).toMatchObject({ error: expect.any(String) })
  expect(registry.byAgent(row.agentId)).toBe(row)
})

// A machine restart stops a Swarm worker; reopened on its own conversation it is resume-only, and is still the Swarm's
// (2026-10-23: such a worker could no longer be stopped by the Swarm).
it('a Swarm close closes a worker reopened on the conversation it was started with', async () => {
  row.startedBy = 'agent'
  row.resumeOnly = true
  expect(await service.request({ ...request('now'), onlyIfOriginalLaunch: true })).toEqual({ closed: true })
})

// The review of #1635: Close after task answered a Swarm Lead "deferred", saved its plan, and said LEAD_PROTECTED only once
// the task ended. A Lead is refused at once, for every kind of close, before anything is read, saved or stopped.
it.each(['now', 'idle', 'after_task'] as const)('refuses to close a Swarm Lead (%s) at once, saving no plan', async mode => {
  const svc = new CloseAgentService({ ...deps, leadProtected: id => id === row.agentId })
  expect(await svc.request(request(mode))).toEqual({ error: 'LEAD_PROTECTED', detail: LEAD_PROTECTED_DETAIL })
  expect(registry.byAgent(row.agentId)?.closePlan).toBeUndefined()
  expect(deps.activity).not.toHaveBeenCalled()
  expect(deps.stop).not.toHaveBeenCalled()
  expect(await svc.request(request('inspect'))).toEqual({ activity: expect.any(String) })
  svc.dispose()
})

it.each(['before', 'activity', 'checkpoint'] as const)('an expired native close lease preserves the worker at %s', async phase => {
  const guarded = { ...request('now'), expiresAt: time + 1 }
  if (phase === 'before') time += 2
  if (phase === 'activity') vi.mocked(deps.activity).mockImplementation(async () => { time += 2; return 'idle' })
  if (phase === 'checkpoint') vi.mocked(deps.checkpoint).mockImplementation(async () => { time += 2 })
  expect(await service.request(guarded)).toMatchObject({ error: expect.any(String) })
  expect(registry.byAgent(row.agentId)).toBe(row)
})

it('backs up an idle session before stopping, without treating a tab switch as Close', async () => {
  service.start()
  expect(deps.activity).not.toHaveBeenCalled()
  expect(await service.request(request())).toEqual({ closed: true })
  expect(deps.checkpoint).toHaveBeenCalledOnce()
  expect(deps.activity).toHaveBeenCalledTimes(2)
})
it.each<CloseActivity>(['working', 'needs_input', 'draft', 'unknown'])('leaves %s work alive until explicitly approved', async activity => {
  vi.mocked(deps.activity).mockResolvedValue(activity)
  expect(await service.request(request('inspect'))).toEqual({ activity })
  expect(await service.request(request())).toEqual({ error: 'SESSION_NOT_IDLE', activity })
  expect(deps.stop).not.toHaveBeenCalled()
  expect(await service.request(request('now'))).toEqual({ closed: true })
  expect(deps.checkpoint).toHaveBeenCalledOnce()
})
it.each(['session', 'creation'] as const)('rejects an outdated %s before reading or stopping', async part => {
  const stale = request()
  if (part === 'session') row.sessionId = 'new'
  else row.registeredAt++
  expect(await service.request(stale)).toEqual({ error: 'AGENT_CHANGED' })
  expect(deps.activity).not.toHaveBeenCalled()
  expect(deps.stop).not.toHaveBeenCalled()
})
it('rechecks activity after the checkpoint so newly started work stays alive', async () => {
  vi.mocked(deps.activity).mockResolvedValueOnce('idle').mockResolvedValue('working')
  expect(await service.request(request())).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'working' })
  expect(registry.byAgent(row.agentId)).toBe(row)
})
it('checkpoint failure retains the session and reports the failure', async () => {
  vi.mocked(deps.checkpoint).mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'HISTORY_NOT_SAVED' }))
  expect(await service.request(request())).toMatchObject({ error: 'HISTORY_NOT_SAVED', detail: 'Disk full' })
  expect(registry.byAgent(row.agentId)).toBe(row)
})
it('a queued Close preserves its intent and reason while native identity is unavailable, then retries', async () => {
  vi.mocked(deps.stop).mockRejectedValueOnce(new IdentityReadUnavailable('the process record is incomplete'))
  await expect(service.request(request('after_task'))).resolves.toEqual({ deferred: true })
  const plan = row.closePlan!
  await service.tick()
  time += 5_000
  await service.tick()
  expect(registry.byAgent(row.agentId)?.closePlan).toEqual({ ...plan,
    state: 'waiting', detail: 'Conversation identity is held: the process record is incomplete.' })
  expect(deps.checkpoint).not.toHaveBeenCalled()
  await service.tick()
  expect(deps.stop).toHaveBeenCalledTimes(2)
  expect(deps.checkpoint).toHaveBeenCalledOnce()
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it.each(['capture', 'checkpoint'] as const)('a queued Pi Close retries real native evidence held during %s', async phase => {
  const previousHome = env.PI_HOME
  env.PI_HOME = join(env.ADAPTER_DATA_DIR, 'pi-close', row.agentId)
  const cwd = join(env.PI_HOME, 'workspace'), directory = join(env.PI_HOME, 'checkpoints')
  mkdirSync(cwd, { recursive: true })
  Object.assign(row, { engine: 'pi', sessionId: 'queued-conversation', transcriptPath: null, cwd, codexHome: undefined })
  const folder = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder(cwd))
  mkdirSync(folder, { recursive: true }); mkdirSync(directory)
  const native = join(folder, `day_${row.sessionId}.jsonl`), duplicate = join(folder, `next_${row.sessionId}.jsonl`)
  const header = JSON.stringify({ type: 'session', id: row.sessionId, cwd }) + '\n'
  const store = new SessionCheckpointStore(directory)
  deps.checkpoint = vi.fn(s => store.save(s, { screen: 'The private terminal is idle' }))
  deps.stop = vi.fn(async (id, options) => {
    const captured = { ...row }
    if (phase === 'capture') captured.transcriptPath = await findResumedTranscript('pi', row.sessionId, { cwd })
    await options.checkpoint!(captured, 'before')
    await options.beforeStop!(captured)
    expect(options.current!()).toBe(true)
    registry.removeAgent(id)
  })
  try {
    writeFileSync(native, '{partial')
    expect(await service.request(request('after_task'))).toEqual({ deferred: true })
    const plan = row.closePlan!
    await service.tick(); time += 5_000; await service.tick()
    expect(registry.byAgent(row.agentId)?.closePlan).toMatchObject({ id: plan.id, state: 'waiting', detail: expect.stringContaining('could not be read') })
    expect(readdirSync(directory)).toEqual([])
    writeFileSync(native, header); writeFileSync(duplicate, header)
    await service.tick()
    expect(registry.byAgent(row.agentId)?.closePlan).toMatchObject({ id: plan.id, state: 'waiting', detail: 'More than one file matches this Pi conversation.' })
    expect(readdirSync(directory)).toEqual([])
    rmSync(duplicate)
    await service.tick()
    expect(registry.byAgent(row.agentId)).toBeUndefined()
    const saved = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(file => /^[a-f0-9]{64}\.json$/.test(file))!), 'utf8'))
    expect(saved.source).toBe(native)
    expect(readFileSync(join(directory, saved.file), 'utf8')).toBe(header)
    expect(deps.stop).toHaveBeenCalledTimes(3)
  } finally { env.PI_HOME = previousHome }
})
it('cleanup requires open-tab support and checks again after history is saved', async () => {
  const close = { ...request('now'), onlyIfHidden: true }
  expect(await service.request(close)).toMatchObject({ error: 'UNSUPPORTED' })
  deps.openTabs = { isHidden: () => true, assertHidden: vi.fn().mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Object.assign(new Error('Now in a tab'), { code: 'SESSION_IN_TAB' })) }
  expect(await service.request(close)).toMatchObject({ error: 'SESSION_IN_TAB' })
  expect(deps.checkpoint).toHaveBeenCalledOnce()
  expect(registry.byAgent(row.agentId)).toBe(row)
})
it('a new local tab cancels cleanup at the final process fence', async () => {
  let hidden = true
  deps.openTabs = { isHidden: () => hidden, assertHidden: vi.fn(async () => {}) }
  vi.mocked(deps.stop).mockImplementation(async (_id, options) => {
    await options.beforeStop?.(row)
    hidden = false
    expect(options.current?.()).toBe(false)
    throw new Error('Opened while closing')
  })
  expect(await service.request({ ...request('now'), onlyIfHidden: true })).toMatchObject({ error: 'CLOSE_FAILED' })
  expect(registry.byAgent(row.agentId)).toBe(row)
})
it('an explicitly reviewed cleanup closes unknown activity through the history checkpoint', async () => {
  deps.openTabs = { isHidden: () => true, assertHidden: vi.fn(async () => {}) }
  vi.mocked(deps.activity).mockResolvedValue('unknown')
  expect(await service.request({ ...request('now'), onlyIfHidden: true })).toEqual({ closed: true })
  expect(deps.checkpoint).toHaveBeenCalledOnce()
  expect(deps.openTabs.assertHidden).toHaveBeenCalledTimes(2)
})
it('joins repeated clicks and cancels a pending close when reopened during its backup', async () => {
  let finish!: () => void
  vi.mocked(deps.checkpoint).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = service.request(request())
  expect(service.request(request())).toBe(first)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  service.cancel(row.agentId)
  finish()
  expect((await first).error).toBeTruthy()
  expect(registry.byAgent(row.agentId)).toBe(row)
})
// Two windows on one agent (e2e/windows.e2e.ts): a request is answered by a job of its own kind only.
it('a close asked for while another window\'s inspect is still reading is carried out, and each is answered for itself', async () => {
  let read!: (activity: CloseActivity) => void
  vi.mocked(deps.activity).mockImplementationOnce(() => new Promise(resolve => { read = resolve }))
  const inspecting = service.request(request('inspect'))
  await vi.waitFor(() => expect(read).toBeTypeOf('function'))
  const closing = service.request(request('now'))
  expect(closing).not.toBe(inspecting)
  read('idle')
  expect(await inspecting).toEqual({ activity: 'idle' })
  expect(await closing).toEqual({ closed: true })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it('an inspect asked for while a close is saving waits for it, and is never answered as the close', async () => {
  let finish!: () => void
  vi.mocked(deps.checkpoint).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const closing = service.request(request('now'))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const inspecting = service.request(request('inspect'))
  finish()
  expect(await closing).toEqual({ closed: true })
  expect(await inspecting).toEqual({ error: 'AGENT_CHANGED' })
})
it('a close of one already closed, the same conversation, is closed: asked after it, or waiting behind the close that did it', async () => {
  // A window closing a tab closes its panes one at a time; the harnesses a pane's harness started close with it
  // (services/agentCleanup.ts), and the window's own close of one of them was answered AGENT_CHANGED.
  const asked = request()
  const closedAlready = vi.fn((r: AgentCloseRequest) => r.agentId === asked.agentId && r.sessionId === asked.sessionId && !registry.byAgent(r.agentId))
  service.dispose()
  service = new CloseAgentService({ ...deps, closedAlready })
  let finish!: () => void
  vi.mocked(deps.checkpoint).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const cleanup = service.request(request('now'))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const window = service.request(request('idle'))
  finish()
  expect(await cleanup).toEqual({ closed: true })
  expect(await window).toEqual({ closed: true })
  expect(await service.request(request('now'))).toEqual({ closed: true })
  expect(deps.stop).toHaveBeenCalledOnce()
  // A close after its task is about a live one: it changed.
  expect(await service.request(request('after_task'))).toEqual({ error: 'AGENT_CHANGED' })
  // Another conversation by that id was not closed.
  expect(await service.request({ ...request('now'), sessionId: 'other' })).toEqual({ error: 'AGENT_CHANGED' })
})
it('an inspect of one already closed, the same conversation, is closed', async () => {
  // The terminal client inspects before every close: one asked again after a close it shows as unconfirmed (its
  // answer lost, or the harness bound a conversation meanwhile) was answered AGENT_CHANGED, "Stop not confirmed".
  const asked = request()
  const closedAlready = vi.fn((r: AgentCloseRequest) => r.agentId === asked.agentId && r.sessionId === asked.sessionId && !registry.byAgent(r.agentId))
  service.dispose()
  service = new CloseAgentService({ ...deps, closedAlready })
  expect(await service.request(request('now'))).toEqual({ closed: true })
  expect(await service.request(request('inspect'))).toEqual({ closed: true })
  expect(await service.request({ ...request('inspect'), sessionId: 'other' })).toEqual({ error: 'AGENT_CHANGED' })
  expect(deps.stop).toHaveBeenCalledOnce()
  expect(deps.activity).toHaveBeenCalledOnce()
})
it('a close now asked for while a close after the task is being planned closes now', async () => {
  let read!: (activity: CloseActivity) => void
  vi.mocked(deps.activity).mockImplementationOnce(() => new Promise(resolve => { read = resolve }))
  const deferring = service.request(request('after_task'))
  await vi.waitFor(() => expect(read).toBeTypeOf('function'))
  const closing = service.request(request('now'))
  read('working')
  expect(await deferring).toEqual({ deferred: true })
  expect(await closing).toEqual({ closed: true })
  expect(deps.stop).toHaveBeenCalledOnce()
})
it('a person\'s own close is not answered by a cleanup that finds the agent on screen again', async () => {
  let shown!: () => void
  deps.openTabs = { isHidden: () => false, assertHidden: vi.fn(() => new Promise<void>((_, reject) => {
    shown = () => reject(Object.assign(new Error('Now in a tab'), { code: 'SESSION_IN_TAB' }))
  })) }
  const cleanup = service.request({ ...request('now'), onlyIfHidden: true })
  await vi.waitFor(() => expect(shown).toBeTypeOf('function'))
  const closing = service.request(request('now'))
  shown()
  expect(await cleanup).toMatchObject({ error: 'SESSION_IN_TAB' })
  expect(await closing).toEqual({ closed: true })
})
it('persists a deferred close, survives a daemon restart and waits for sustained idle', async () => {
  vi.mocked(deps.activity).mockResolvedValue('working')
  expect(await service.request(request('after_task'))).toEqual({ deferred: true })
  const plan = row.closePlan!
  expect(plan.state).toBe('waiting')
  expect(deps.stop).not.toHaveBeenCalled()
  expect(await service.request(request('after_task'))).toEqual({ deferred: true })
  expect(row.closePlan?.id).toBe(plan.id)
  service.dispose()
  registry.load()
  row = registry.byAgent(row.agentId)!
  expect(row.closePlan?.id).toBe(plan.id)
  service = new CloseAgentService(deps)
  await service.tick()
  vi.mocked(deps.activity).mockResolvedValue('idle')
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  time += 5_000
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
})

it('durably records a deferred close that arrives during a registry discovery transaction', async () => {
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  const transaction = registry.transaction(async () => { await hold })
  try {
    const closing = service.request(request('after_task'))
    await vi.waitFor(() => expect(deps.activity).toHaveBeenCalledOnce())
    await new Promise(resolve => setImmediate(resolve))
    expect(row.closePlan).toBeUndefined()
    finish()
    await transaction
    expect(await closing).toEqual({ deferred: true })
    expect(registry.byAgent(row.agentId)?.closePlan?.state).toBe('waiting')
    registry.load()
    expect(registry.byAgent(row.agentId)?.closePlan?.state).toBe('waiting')
  } finally { finish(); await transaction }
})

it('does not defer a close if its conversation changes before the discovery transaction commits', async () => {
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  const transaction = registry.transaction(async () => { await hold })
  try {
    const closing = service.request(request('after_task'))
    await vi.waitFor(() => expect(deps.activity).toHaveBeenCalledOnce())
    row.sessionId = 'another-conversation'
    finish()
    await transaction
    expect(await closing).toEqual({ error: 'AGENT_CHANGED' })
    expect(row.closePlan).toBeUndefined()
  } finally { finish(); await transaction }
})
it('keeps questions and subsequent turns alive during a deferred close', async () => {
  await service.request(request('after_task'))
  await service.tick()
  time += 5_000
  vi.mocked(deps.activity).mockResolvedValue('needs_input')
  await service.tick()
  vi.mocked(deps.activity).mockResolvedValue('working')
  await service.tick()
  vi.mocked(deps.activity).mockResolvedValue('idle')
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  time += 5_000
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
})
it.each(['cancel', 'new-process', 'new-conversation'] as const)('does not execute a queued close after %s', async action => {
  await service.request(request('after_task'))
  await service.tick()
  time += 5_000
  if (action === 'cancel') expect(await service.request(request('cancel'))).toEqual({ cancelled: true })
  else if (action === 'new-process') row.processIdentity!.startMarker = 'replacement'
  else row.sessionId = 'replacement'
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  expect(row.closePlan).toBeUndefined()
})
it('reports one deferred save failure instead of retrying forever', async () => {
  await service.request(request('after_task'))
  await service.tick()
  vi.mocked(deps.checkpoint).mockRejectedValue(new Error('Disk full'))
  time += 5_000
  await service.tick()
  expect(row.closePlan).toMatchObject({ state: 'failed', detail: 'Disk full' })
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
})
it('will not acknowledge a deferred close when durable storage fails', async () => {
  vi.spyOn(registry, 'setClosePlan').mockImplementation(() => { throw new Error('Disk full') })
  expect(await service.request(request('after_task'))).toMatchObject({ error: 'CLOSE_FAILED' })
  expect(deps.stop).not.toHaveBeenCalled()
})

it('uses a known empty composer, not inactivity, to establish idle', () => {
  const screen = '›\n\n  100% context left'
  expect(inspectCloseActivity(row, screen, false, false)).toBe('idle')
  expect(inspectCloseActivity(row, screen, undefined, false)).toBe('unknown')
  expect(inspectCloseActivity(row, screen, true, false)).toBe('working')
  expect(inspectCloseActivity(row, screen, false, true)).toBe('needs_input')
  expect(inspectCloseActivity(row, null, false, false)).toBe('unknown')
  expect(inspectCloseActivity(row, '› A draft\n  100% context left', false, false)).toBe('draft')
  expect(inspectCloseActivity(row, `${screen}\n  ◎ /goal active (41m)`, false, false)).toBe('working')
  expect(inspectCloseActivity({ ...row, engine: 'claude' }, '❯\n  2 background tasks', false, false)).toBe('working')
})

it('reads Codex 0.160\'s goal indicator: pursuing one is working, every other state is not', () => {
  // As 0.160 draws it with its status line on: the composer empty with its dim placeholder, and the
  // goal in magenta at the right of the status line (tui/src/bottom_pane/footer.rs).
  const screen = (goal: string) => '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n'
    + `  gpt-5.6-sol default · /tmp/project                      \u001b[35m${goal}\u001b[0m`
  expect(inspectCloseActivity(row, screen('Pursuing goal (41m)'), false, false)).toBe('working')
  expect(inspectCloseActivity(row, screen('Pursuing goal'), false, false)).toBe('working')
  for (const state of ['Goal paused (/goal resume)', 'Goal stalled (/goal resume)', 'Goal hit usage limits (/goal resume)',
    'Goal unmet (41m)', 'Goal abandoned', 'Goal achieved (41m)', 'Goal achieved']) {
    expect(inspectCloseActivity(row, screen(state), false, false), state).toBe('idle')
  }
})

it('reads Codex browsing its transcript as someone at the pane, not as idle', () => {
  const browsing = '\u001b[2m› Ask Codex to do anything\u001b[0m\n\n\u001b[36mBrowsing\u001b[0m · ↵ rewind · esc back'
  expect(inspectCloseActivity(row, browsing, false, false)).toBe('needs_input')
})

const unusedScreens = {
  // Prompt/footer styling observed in the unused Companions terminal; path redacted.
  codex: '\u001b[1m\u001b[38;5;215m›\u001b[0m\u001b[48;5;234m \u001b[2mAsk Codex to do anything\u001b[0m\n\n  GPT-6-Astra max · /tmp/companions\n  ? for shortcuts · 1 warning · f2 to view',
  claude: '────────────\n❯\u00a0\u001b[2mAsk about the codebase\u001b[0m\n────────────\n  ? for shortcuts',
}

it.each(['claude', 'codex'] as const)('closes an unused %s chat only after saving its screen', async engine => {
  Object.assign(row, { engine, sessionId: '', transcriptPath: null, launch: { state: 'ready' } })
  const screen = unusedScreens[engine]
  const directory = join(env.ADAPTER_DATA_DIR, 'unused-checkpoints', row.agentId)
  const store = new SessionCheckpointStore(directory)
  deps.activity = vi.fn(async () => inspectCloseActivity(row, screen, undefined, false))
  deps.checkpoint = vi.fn((s, phase) => store.save(s, { screen: phase === 'before' ? screen : null }))
  deps.stop = vi.fn(async (id, options) => {
    await options.checkpoint!(row, 'before')
    await options.beforeStop!(row)
    const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => /^[a-f0-9]{64}\.json$/.test(f))!), 'utf8'))
    expect(JSON.parse(readFileSync(join(directory, manifest.file), 'utf8')).screen).toBe(screen)
    expect(options.current!()).toBe(true)
    await options.checkpoint!(row, 'after')
    registry.removeAgent(id)
  })
  expect(await service.request(request('inspect'))).toEqual({ activity: 'idle' })
  expect(await service.request(request('idle'))).toEqual({ closed: true })
  expect(deps.checkpoint).toHaveBeenNthCalledWith(1, row, 'before')
  expect(deps.checkpoint).toHaveBeenNthCalledWith(2, row, 'after')
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})

it.each([
  [null, 'unknown'],
  ['Starting Codex…', 'unknown'],
  ['unrecognized terminal screen', 'unknown'],
  ['› Keep this draft\n  100% context left', 'draft'],
  ['›\n  a multiline draft\n  100% context left', 'draft'],
  ['›\nAllow this action', 'needs_input'],
  ['• Working (4s · esc to interrupt)\n›\n  100% context left', 'working'],
  [`${unusedScreens.codex}\n ◎ /goal active (41m)`, 'working'],
] as const)('does not treat an unused chat as idle with %j', (screen, activity) => {
  Object.assign(row, { sessionId: '', transcriptPath: null })
  expect(inspectCloseActivity(row, screen, undefined, false)).toBe(activity)
  expect(inspectCloseActivity(row, unusedScreens.codex, true, false)).toBe('working')
  expect(inspectCloseActivity(row, unusedScreens.codex, undefined, true)).toBe('needs_input')
})

it.each([
  { sessionId: 'existing-conversation' },
  { transcriptPath: '/tmp/existing-conversation.jsonl' },
  { boundAt: 1 },
  { resumeOnly: true as const },
  { launch: { state: 'starting' as const } },
  { launch: { state: 'failed' as const, error: 'START_FAILED' } },
  { engine: 'terminal' as const },
])('retains unknown turn state with %j', change => {
  const session = { ...row, sessionId: '', transcriptPath: null, ...change }
  expect(inspectCloseActivity(session, '›\n\n  100% context left', undefined, false)).toBe('unknown')
})

it.each(['working', 'draft', 'unknown'] as const)('retains an unused chat that becomes %s while saving', async activity => {
  Object.assign(row, { sessionId: '', transcriptPath: null })
  vi.mocked(deps.activity).mockResolvedValueOnce('idle').mockResolvedValue(activity)
  expect(await service.request(request('idle'))).toEqual({ error: 'SESSION_NOT_IDLE', activity })
  expect(registry.byAgent(row.agentId)).toBe(row)
})

it('automatically stops only after two timer observations of sustained idle', async () => {
  vi.useFakeTimers()
  service.dispose()
  const { now: _now, ...realClock } = deps
  service = new CloseAgentService(realClock)
  await service.request(request('after_task'))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(deps.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(deps.stop).toHaveBeenCalledOnce()
  service.dispose()
  await service.tick()
})
it.each(['unavailable', 'untyped', 'cancelled', 'disposed'] as const)('keeps a queued Close visible through an activity read that is %s', async phase => {
  await service.request(request('after_task'))
  const plan = row.closePlan!
  vi.mocked(deps.activity).mockImplementationOnce(async () => {
    if (phase === 'cancelled') service.cancel(row.agentId)
    if (phase === 'disposed') service.dispose()
    throw phase === 'untyped' ? null : new Error('The conversation reader is unavailable.')
  })
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  if (phase === 'cancelled') expect(row.closePlan).toBeUndefined()
  else if (phase === 'disposed') expect(row.closePlan).toEqual(plan)
  else {
    expect(row.closePlan).toMatchObject({ id: plan.id, state: 'waiting', detail: expect.any(String) })
    expect(deps.changed).toHaveBeenLastCalledWith(row)
    await service.tick()
    time += 5_000
    await service.tick()
    expect(deps.stop).toHaveBeenCalledOnce()
  }
})
it('resets a deferred idle observation after a failed read instead of stopping on stale evidence', async () => {
  await service.request(request('after_task'))
  await service.tick()
  time += 5_000
  vi.mocked(deps.activity).mockRejectedValueOnce(new Error('disconnected'))
  await service.tick()
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  time += 4_999
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
  time += 1
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
})
it.each(['persist', 'notify'] as const)('contains a failed Close reason %s and retries the existing intent', async stage => {
  await service.request(request('after_task'))
  const id = row.closePlan!.id
  vi.mocked(deps.activity).mockRejectedValueOnce(new Error('Reader unavailable'))
  if (stage === 'persist') vi.spyOn(registry, 'setClosePlan').mockImplementationOnce(() => { throw Error('Disk full') })
  else vi.mocked(deps.changed).mockImplementationOnce(() => { throw Error('Client disconnected') })
  await expect(service.tick()).resolves.toBeUndefined()
  expect(row.closePlan).toMatchObject({ id, state: 'waiting' })
  expect(deps.stop).not.toHaveBeenCalled()
  await service.tick()
  time += 5_000
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
})
it('rejects a disposed service and a target replaced while reading activity', async () => {
  service.dispose()
  expect(await service.request(request('inspect'))).toEqual({ error: 'AGENT_CHANGED' })
  service = new CloseAgentService(deps)
  vi.mocked(deps.activity).mockImplementation(async () => { row.processIdentity!.pid++; return 'idle' })
  expect(await service.request(request('inspect'))).toEqual({ error: 'AGENT_CHANGED' })
  expect(deps.stop).not.toHaveBeenCalled()
})
it('never automatically closes a shell on an empty composer alone', async () => {
  row.engine = 'terminal'
  expect(await service.request(request('idle'))).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'unknown' })
  expect(deps.stop).not.toHaveBeenCalled()
})
it('retains the pane if cancellation arrives during the final activity check', async () => {
  vi.mocked(deps.activity).mockResolvedValueOnce('idle').mockImplementationOnce(async () => { service.cancel(row.agentId); return 'idle' })
  expect((await service.request(request())).error).toBe('CLOSE_FAILED')
  expect(registry.byAgent(row.agentId)).toBeTruthy()
})
it('returns a useful error when storage throws a non-Error value', async () => {
  vi.mocked(deps.checkpoint).mockRejectedValue('disk failure')
  expect(await service.request(request())).toMatchObject({ error: 'CLOSE_FAILED', detail: 'Could not close this session safely. Please try again.' })
})
it('does not stop a cancelled deferred plan after its activity read finishes', async () => {
  await service.request(request('after_task'))
  vi.mocked(deps.activity).mockImplementationOnce(async () => { service.cancel(row.agentId); return 'idle' })
  await service.tick()
  expect(deps.stop).not.toHaveBeenCalled()
})
it('a concurrent deferred tick never starts a second stop', async () => {
  await service.request(request('after_task'))
  let finish!: () => void
  vi.mocked(deps.checkpoint).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const closing = service.request(request())
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await service.tick()
  expect(deps.stop).toHaveBeenCalledOnce()
  finish(); await closing
})

function inspectCloseActivity(session: Parameters<typeof inspectCloseReading>[0], capture: string | null, turnOpen: boolean | undefined, needsInput: boolean) {
  return inspectCloseReading(session, capture === null ? null : screenFor(session.engine).inspect(capture), turnOpen, needsInput)
}

// Codex 0.162.1 in a clean macOS VM (2026-10-12): `harness close --now` a second after its start was refused with
// "Conversation identity is held: the native control descriptor type is unavailable." and the harness kept working.
describe('a close of a harness still starting', () => {
  const held = () => new IdentityReadUnavailable('the native control descriptor type is unavailable')
  let slept: number[]
  beforeEach(() => {
    Object.assign(row, { sessionId: '', transcriptPath: null, boundAt: null })
    time = row.registeredAt + 1_000
    slept = []
    deps.sleep = vi.fn(async ms => { slept.push(ms); time += ms })
    service = new CloseAgentService(deps)
  })
  const stops = () => vi.mocked(deps.stop).mock.calls.map(([, options]) => options)
  /** As a hook binds it (registry.register): its first conversation, and no `launch` any more. */
  const bind = (extra: Partial<RegisteredSession> = {}) => { Object.assign(row, { sessionId: 'first', boundAt: time, ...extra }); delete row.launch }

  it('waits for its first conversation to bind, then closes it with that conversation', async () => {
    const asked = request('now')
    vi.mocked(deps.stop).mockRejectedValueOnce(held())
    vi.mocked(deps.sleep!).mockImplementationOnce(async ms => {
      time += ms
      bind({ transcriptPath: '/fixture/first.jsonl' })
    })
    expect(await service.request(asked)).toEqual({ closed: true })
    expect(stops()).toHaveLength(2)
    expect(stops()[1].withoutConversation).toBeUndefined()
    expect(registry.byAgent(row.agentId)).toBeUndefined()
  })
  it('never bound within the wait: stopped without a conversation, and says so', async () => {
    let unbound = 0
    vi.mocked(deps.stop).mockImplementation(async (id, options) => {
      if (!options.withoutConversation) throw held()
      options.withoutConversation()
      unbound++
      registry.removeAgent(id)
    })
    expect(await service.request(request('now'))).toEqual({ closed: true, withoutConversation: true })
    expect(unbound).toBe(1)
    expect(slept.reduce((a, b) => a + b, 0)).toBe(8_000)
    expect(stops().at(-1)?.withoutConversation).toBeTypeOf('function')
    expect(stops().slice(0, -1).every(options => !options.withoutConversation)).toBe(true)
  })
  it('a close that finds it idle stops it the same way; one that finds it working leaves it', async () => {
    vi.mocked(deps.stop).mockImplementation(async (id, options) => {
      if (!options.withoutConversation) throw held()
      registry.removeAgent(id)
    })
    vi.mocked(deps.activity).mockResolvedValue('working')
    expect(await service.request(request('idle'))).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'working' })
    vi.mocked(deps.activity).mockResolvedValue('idle')
    // A stop that never says it went without a conversation is a close that kept what it had.
    expect(await service.request(request('idle'))).toEqual({ closed: true })
  })
  it('a conversation bound while a try ran is closed with it at once, which that try read as a change', async () => {
    vi.mocked(deps.stop).mockImplementationOnce(async () => {
      bind()
      throw Object.assign(new Error('Harness changed while saving its conversation. Try stopping again.'), { code: 'STOP_UNCONFIRMED' })
    })
    expect(await service.request(request('now'))).toEqual({ closed: true })
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(stops()).toHaveLength(2)
  })
  it('bound by the last try of the wait: tried once more with its conversation, not let go', async () => {
    let calls = 0
    vi.mocked(deps.stop).mockImplementation(async (id, options) => {
      if (++calls === 9) bind()
      if (calls < 10) throw held()
      expect(options.withoutConversation).toBeUndefined()
      registry.removeAgent(id)
    })
    expect(await service.request(request('now'))).toEqual({ closed: true })
    expect(calls).toBe(10)
  })
  it('a refusal of its own is answered at once', async () => {
    vi.mocked(deps.stop).mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'HISTORY_NOT_SAVED' }))
    expect(await service.request(request('now'))).toMatchObject({ error: 'HISTORY_NOT_SAVED', detail: 'Disk full' })
    expect(deps.sleep).not.toHaveBeenCalled()
  })
  it('a conversation that binds and still cannot be read is never stopped without it', async () => {
    vi.mocked(deps.stop).mockRejectedValue(held())
    vi.mocked(deps.sleep!).mockImplementationOnce(async ms => { time += ms; bind() })
    expect(await service.request(request('now'))).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', detail: expect.stringContaining('descriptor') })
    expect(stops().every(options => !options.withoutConversation)).toBe(true)
    expect(registry.byAgent(row.agentId)).toBe(row)
  })
  it.each([
    ['launched over a minute ago', () => { time = row.registeredAt + 60_000 }],
    ['an engine typed into a terminal', () => { row.terminalHost = true }],
    ['a resume', () => { row.resumeOnly = true }],
    ['one discovery found', () => { delete row.launch }],
    ['a fork, which starts on a copy of another conversation', () => { row.forkedFrom = { agentId: 'parent', name: 'parent', sessionId: 'theirs' } }],
    ['whose engine started over a minute ago', () => { row.processIdentity!.startMarker = new Date(row.registeredAt - 1_000).toString(); time = row.registeredAt + 60_000 }],
    ['seen through a clock that went back', () => { time = row.registeredAt - 1 }],
  ] as const)('a harness %s is refused at once, as before', async (_, arrange) => {
    arrange()
    service = new CloseAgentService(deps)
    vi.mocked(deps.stop).mockRejectedValue(held())
    expect(await service.request(request('now'))).toMatchObject({ error: 'IDENTITY_UNAVAILABLE' })
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(registry.byAgent(row.agentId)).toBe(row)
  })
  it('an inspect answers at once', async () => {
    vi.mocked(deps.activity).mockRejectedValue(held())
    expect(await service.request(request('inspect'))).toMatchObject({ error: 'IDENTITY_UNAVAILABLE' })
    expect(deps.sleep).not.toHaveBeenCalled()
  })
  it.each(['reopened', 'replaced', 'disposed', 'removed'] as const)('the wait ends when the harness is %s', async change => {
    vi.mocked(deps.stop).mockRejectedValue(held())
    vi.mocked(deps.sleep!).mockImplementationOnce(async ms => {
      time += ms
      if (change === 'reopened') service.cancel(row.agentId)
      else if (change === 'replaced') row.processIdentity = { pid: 778, startMarker: 'reborn', executable: 'codex' }
      else if (change === 'disposed') service.dispose()
      else registry.removeAgent(row.agentId)
    })
    expect(await service.request(request('now'))).toEqual({ error: 'AGENT_CHANGED' })
    expect(stops()).toHaveLength(1)
  })
  it('the harness replaced as the wait ends is not stopped without a conversation', async () => {
    vi.mocked(deps.stop).mockRejectedValue(held())
    vi.mocked(deps.sleep!).mockImplementation(async ms => {
      time += ms
      if (slept.push(ms) === 8) row.processIdentity = { pid: 778, startMarker: 'reborn', executable: 'codex' }
    })
    expect(await service.request(request('now'))).toEqual({ error: 'AGENT_CHANGED' })
    expect(stops().every(options => !options.withoutConversation)).toBe(true)
  })
  it('a harness whose engine installed first is starting from its engine\'s own start', async () => {
    time = row.registeredAt + 5 * 60_000
    row.processIdentity!.startMarker = new Date(time - 2_000).toString()
    vi.mocked(deps.stop).mockImplementationOnce(async () => { throw held() })
    vi.mocked(deps.sleep!).mockImplementationOnce(async ms => { time += ms; bind() })
    expect(await service.request(request('now'))).toEqual({ closed: true })
    expect(deps.sleep).toHaveBeenCalledOnce()
  })
  it('a close asked of it before its first conversation bound still names it', async () => {
    const asked = request('now')
    bind()
    expect(await service.request(asked)).toEqual({ closed: true })
    // Not once it is past starting, nor for a conversation it moved on from.
    const later = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%89' }], cwd: '/tmp' })!
    Object.assign(later, { sessionId: 'second' })
    time = later.registeredAt + 60_000
    expect(await service.request({ agentId: later.agentId, sessionId: '', createdAt: new Date(later.registeredAt).toISOString(), mode: 'now' }))
      .toEqual({ error: 'AGENT_CHANGED' })
    time = later.registeredAt + 1_000
    expect(await service.request({ agentId: later.agentId, sessionId: 'first', createdAt: new Date(later.registeredAt).toISOString(), mode: 'now' }))
      .toEqual({ error: 'AGENT_CHANGED' })
  })
})
it('waits on a real timer when no sleep is given', async () => {
  vi.useFakeTimers()
  Object.assign(row, { sessionId: '', transcriptPath: null, boundAt: null })
  const start = Date.now()
  deps.now = () => Date.now()
  service = new CloseAgentService(deps)
  vi.mocked(deps.stop).mockRejectedValueOnce(new IdentityReadUnavailable('the native control descriptor type is unavailable'))
  const closing = service.request(request('now'))
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await closing).toEqual({ closed: true })
  expect(Date.now() - start).toBe(1_000)
})
