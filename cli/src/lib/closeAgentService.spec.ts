import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloseAgentService, inspectCloseActivity, type CloseActivity, type CloseAgentServiceDeps, type AgentCloseRequest } from './closeAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'

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
