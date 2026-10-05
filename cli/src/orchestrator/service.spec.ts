import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as filesystem from 'node:fs/promises'
import * as privateState from '../lib/secureState.js'
import { OrchestratorService, type OrchestratorDependencies } from './service.js'
import { OrchestratorError, Run, type Task } from './model.js'
import { compileFlow, parseFlowSource, pinnedFlowName } from './flow.js'
import { processGone, type StepSpawner } from './steps.js'
import { orchestratorRequest } from './wire.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename), stat: vi.fn(actual.stat), open: vi.fn(actual.open), copyFile: vi.fn(actual.copyFile), writeFile: vi.fn(actual.writeFile) }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
import * as fs from 'node:fs'
const diskFull = () => vi.mocked(fs.writeFileSync).mockImplementation(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })

vi.mock('./outputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./outputs.js')>()
  return { ...actual, checkOutputs: vi.fn(actual.checkOutputs), readVerdictSnapshot: vi.fn(actual.readVerdictSnapshot) }
})
import * as outputsModule from './outputs.js'

const id = '0123456789abcdef0123456789abcdef'
const task = (id: string, dependsOn: string[] = [], harness = 'test/cad') => ({ id, title: id, harness, prompt: `Build ${id} and verify it`, dependsOn })
describe('durable orchestrator lifecycle', () => {
  let root: string, service: OrchestratorService, deps: OrchestratorDependencies
  let launches: Parameters<OrchestratorDependencies['create']>[0][]
  let agents: Set<string>, sent: string[], cancelled: string[]
  const tasks = (): Task[] => service.snapshot(id).tasks as Task[]
  const active = async (): Promise<void> => { await vi.waitFor(() => expect(service.snapshot(id).state).toBe('active')) }
  const running = async (taskId: string): Promise<Task> => {
    await vi.waitFor(() => expect(tasks().find(t => t.id === taskId)?.state).toBe('running'))
    return tasks().find(t => t.id === taskId)!
  }
  const start = () => service.start({ id, engine: 'claude', prompt: 'Make something useful', parallelism: 2 })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestrator-spec-'))
    launches = []; agents = new Set(); sent = []; cancelled = []
    deps = {
      stateDir: join(root, 'state'), workspaceDir: join(root, 'projects'), command: 'harness orchestrator',
      supportsEngine: e => e === 'claude',
      catalog: () => ['cad', 'blender', 'video', 'research'].map(name => ({ id: `test/${name}`, name, description: name, engine: 'claude', viewer: name !== 'research' })),
      create: async input => { launches.push(input); const agentId = `agent-${launches.length}`; agents.add(agentId); return { agentId } },
      send: (_agent, text) => { sent.push(text) }, cancel: agent => { cancelled.push(agent) },
      agent: agent => agents.has(agent) ? { viewerUrl: `http://127.0.0.1:9999/${agent}` } : null,
    }
    service = new OrchestratorService(deps)
  })
  afterEach(() => { service.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('starts once, preserves permissions, and rejects a conflicting creation retry', async () => {
    await Promise.all([start(), start()]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].bypassPermission).toBe(false)
    expect(launches[0].prompt.length).toBeLessThan(2000)
    expect(readFileSync(join(launches[0].cwd, 'ORCHESTRATOR.md'), 'utf8')).toContain('test/blender')
    await expect(service.start({ id, engine: 'claude', prompt: 'Different' })).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' })
  })
  it('keeps a timeout that cannot be saved as a pending result, stops the worker, and applies it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await start(); await active()
    service.plan(id, [task('part'), task('next', ['part'])])
    const part = await running('part'), sentBefore = sent.length
    const internal = service as unknown as { runs: Map<string, Run>; expire(run: Run, task: Task, attempt: number): Promise<void> }
    const run = internal.runs.get(id)!
    run.tasks.find(t => t.id === 'part')!.timeoutMs = 60_000 // planned tasks cannot set one: defensive, an automatic failure on a director run
    diskFull()
    try { await internal.expire(run, run.tasks.find(t => t.id === 'part')!, 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    // The timeout is kept for the resume, but its worker is stopped at once: the time limit holds.
    expect(run.tasks.find(t => t.id === 'part')!.state).toBe('running')
    expect(run).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) })
    expect(cancelled).toEqual([part.agentId])
    expect(run.messages.some(m => m.text.startsWith('Task part attempt 1 failed.'))).toBe(false)
    await service.resume(id)
    expect(run.tasks.find(t => t.id === 'part')).toMatchObject({ state: 'failed', error: 'Timed out after 1m.' })
    expect(sent).toHaveLength(sentBefore + 1)
    expect(sent.at(-1)).toContain('Task part attempt 1 failed. Timed out after 1m.')
    expect(run.tasks.find(t => t.id === 'next')!.state).toBe('blocked')
  })
  it('does not mark a task succeeded when it is cancelled while its artifacts are being saved', async () => {
    await start(); await active()
    service.plan(id, [task('part')])
    const part = await running('part')
    writeFileSync(join(part.cwd, 'part.step'), 'cad')
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { service.cancel(id, 'part'); return realRename(from, to) })
    await expect(service.finish(id, 'part', 1, 'done', ['part.step'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(tasks()[0].state).toBe('cancelled')
    expect(service.snapshot(id).state).toBe('active')
  })
  it('never saves a stale attempt into the artifact folder of the attempt that replaced it', async () => {
    await start(); await active()
    service.plan(id, [task('part')])
    const part = await running('part')
    writeFileSync(join(part.cwd, 'part.step'), 'cad')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let raced = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (!raced && String(path).endsWith(join('artifacts', 'part'))) { raced = true; service.cancel(id, 'part'); service.retry(id, 'part') }
      return actual.mkdir(path, options)
    })
    await expect(service.finish(id, 'part', 1, 'done', ['part.step'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    const second = await vi.waitFor(async () => { const t = tasks()[0]; expect(t).toMatchObject({ attempt: 2, state: 'running' }); return t })
    expect(existsSync(join(root, 'projects', id, 'artifacts', 'part', 'attempt-2'))).toBe(false)
    writeFileSync(join(second.cwd, 'part.step'), 'cad2')
    await service.finish(id, 'part', 2, 'done again', ['part.step'])
    expect(tasks()[0]).toMatchObject({ state: 'succeeded', attempt: 2 })
  })
  it('validates every dependency and harness before launching any task', async () => {
    await start(); await active()
    for (const plan of [[task('a', ['missing'])], [task('a', ['b']), task('b', ['a'])], [task('a'), task('b', [], 'missing/harness')]]) {
      expect(() => service.plan(id, plan)).toThrow()
      expect(tasks()).toHaveLength(0)
    }
    expect(launches).toHaveLength(1)
  })
  it('fans out and joins different harnesses using pinned, checksummed copies', async () => {
    await start(); await active()
    service.plan(id, [task('part'), task('research', [], 'test/research'), task('scene', ['part', 'research'], 'test/blender'), task('film', ['scene'], 'test/video')])
    const part = await running('part'), research = await running('research')
    expect(tasks().find(t => t.id === 'scene')!.state).toBe('queued')
    writeFileSync(join(part.cwd, 'part.step'), 'verified CAD v1')
    await service.finish(id, 'part', 1, 'Dimensions checked', ['part.step'])
    writeFileSync(join(part.cwd, 'part.step'), 'unpublished CAD v2')
    await service.finish(id, 'research', 1, 'Use a warm, minimal setting.', [])
    const scene = await running('scene')
    expect(readFileSync(join(scene.cwd, 'inputs/part/part.step'), 'utf8')).toBe('verified CAD v1')
    expect(scene.inputs).toEqual({ part: 1, research: 1 })
    expect(readFileSync(join(scene.cwd, 'ORCHESTRATOR_TASK.md'), 'utf8')).toContain('warm, minimal')
    writeFileSync(join(scene.cwd, 'scene.png'), 'render fixture')
    await service.finish(id, 'scene', 1, 'Render checked', ['scene.png'])
    const film = await running('film')
    expect(readFileSync(join(film.cwd, 'inputs/scene/scene.png'), 'utf8')).toBe('render fixture')
    await service.finish(id, 'film', 1, 'Film ready', [])
    service.complete(id, 'Delivered all outputs')
    expect(service.snapshot(id).state).toBe('completed')
    expect(sent).toHaveLength(4)
    expect(research.agentId).toBeTruthy()
  })
  it('names each agent\'s role: specialists are never news, the Director only once nothing is left to run', async () => {
    // What the daemon asks before it lets a turn end ring the dial (CommanderMirrorOpts.isSubagent).
    await start(); await active()
    expect(service.roleOf(launches[0].name === `Director ${id.slice(0, 8)}` ? 'agent-1' : '')).toEqual({ role: 'director', busy: false })
    service.plan(id, [task('part')])
    const part = await running('part')
    expect(service.roleOf(part.agentId!)).toEqual({ role: 'worker' })
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: true })
    expect(service.roleOf('nobody')).toBeNull()
    await service.finish(id, 'part', 1, 'Done', [])
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: false })
    expect(service.roleOf(part.agentId!)).toEqual({ role: 'worker' })   // a finished specialist stays one
  })
  it('limits parallelism and treats a repeated plan as the same work', async () => {
    await start(); await active()
    const plan = [task('a'), task('b'), task('c')]
    service.plan(id, plan); service.plan(id, plan)
    await running('a'); await running('b')
    expect(launches).toHaveLength(3)
    expect(tasks().find(t => t.id === 'c')!.state).toBe('queued')
    await service.finish(id, 'a', 1, 'done', [])
    await running('c')
    expect(launches).toHaveLength(4)
  })
  it('blocks dependencies after failure and retries in a new workspace', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])])
    const first = await running('a')
    await service.finish(id, 'a', 1, 'A required tool is missing', [], true)
    expect(tasks().find(t => t.id === 'b')!.state).toBe('blocked')
    service.retry(id, 'a')
    const second = await running('a')
    expect(second.cwd).not.toBe(first.cwd)
    expect(second.attempt).toBe(2)
    await expect(service.finish(id, 'a', 1, 'Late old output', [])).rejects.toMatchObject({ code: 'STALE_ATTEMPT' })
    await service.finish(id, 'a', 2, 'Fixed and verified', [])
    await running('b')
  })
  it('does not mistake idle for success or complete unfinished work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} })
    expect(tasks()[0].state).toBe('running')
    expect(() => service.complete(id, 'done')).toThrow(/Every task/)
  })
  it('rejects path traversal, outside symlinks, directories, and missing artifacts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    writeFileSync(join(root, 'secret'), 'not a task artifact')
    symlinkSync(join(root, 'secret'), join(a.cwd, 'outside'))
    mkdirSync(join(a.cwd, 'directory'))
    for (const path of ['../secret', join(root, 'secret'), 'outside', 'directory', 'missing']) {
      await expect(service.finish(id, 'a', 1, 'done', [path])).rejects.toThrow()
      expect(tasks()[0].state).toBe('running')
    }
    writeFileSync(join(a.cwd, 'valid.txt'), 'safe')
    await service.finish(id, 'a', 1, 'done', ['valid.txt'])
    expect(tasks()[0].artifacts[0].sha256).toHaveLength(64)
  })
  it('stops only this project, ignores late results, and never kills sessions on close', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])]); const a = await running('a')
    service.cancel(id)
    expect(cancelled.sort()).toEqual(['agent-1', a.agentId].sort())
    expect(tasks().every(t => t.state === 'cancelled')).toBe(true)
    await expect(service.finish(id, 'a', 1, 'late', [])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    service.stop()
    expect(cancelled).toHaveLength(2)
  })
  it('cancels an agent that finishes launching after cancellation', async () => {
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start(); service.cancel(id); resolve({ agentId: 'late-director' })
    await vi.waitFor(() => expect(cancelled).toContain('late-director'))
    expect(service.snapshot(id).state).toBe('cancelled')
  })
  it('refuses blind retry of an uncertain process spawn', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux timed out') }
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].uncertain).toBe(true)
    expect(() => service.retry(id, 'a')).toThrow(/uncertain/)
  })
  it('blocks the dependents of an uncertain specialist at once, so the Director is not kept busy', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux pane could not be registered') }
    service.plan(id, [task('a'), task('b', ['a'])])
    const live = () => (service as unknown as { runs: Map<string, Run> }).runs.get(id)!.tasks // reading these never pumps
    await vi.waitFor(() => expect(live()[0]).toMatchObject({ state: 'blocked', uncertain: true }))
    await vi.waitFor(() => expect(live()[1]).toMatchObject({ state: 'blocked', error: 'An upstream task did not succeed.' }))
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: false })
  })
  it('keeps a saved result taken when delivering it to the Director cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start(); await active()
    service.plan(id, [task('a')]); await running('a')
    const actual = vi.mocked(fs.writeFileSync).getMockImplementation()!
    let writes = 0
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (++writes > 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return actual(file, data, options)
    })
    try { await service.finish(id, 'a', 1, 'done', []) } finally { vi.mocked(fs.writeFileSync).mockImplementation(actual) }
    expect(warn).toHaveBeenCalledWith('[orchestrator] a attempt 1: after the result: ENOSPC: no space left on device, write')
    expect((service as unknown as { runs: Map<string, Run> }).runs.get(id)!.tasks[0].state).toBe('succeeded')
  })
  it('counts a task waiting for an answer as work still out for the Director', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux pane could not be registered') }
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(tasks()[0]).toMatchObject({ state: 'blocked', uncertain: true }))
    const run = (service as unknown as { runs: Map<string, Run> }).runs.get(id)!
    run.tasks[0].state = 'waiting' // Director plans cannot contain approvals (FLOW_ONLY): the model state alone
    expect(service.roleOf('agent-1')).toEqual({ role: 'director', busy: true })
  })
  it('persists transcript and reattaches without launching duplicate agents', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    service.ingest({ type: 'turn_started', agentId: 'agent-1', payload: {} })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Working ' } })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'on it.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1', payload: {} })
    service.stop()
    service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'Working on it.' })]))
    expect(tasks()[0].agentId).toBe('agent-2')
    expect(launches).toHaveLength(2)
    await service.finish(id, 'a', 1, 'recovered result', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('handles lost chat acknowledgments without sending twice', async () => {
    await start(); await active()
    const messageId = '11111111111111111111111111111111'
    service.chat(id, messageId, 'Make it taller')
    service.chat(id, messageId, 'Make it taller')
    expect(sent).toEqual(['Make it taller'])
    expect(() => service.chat(id, messageId, 'Different message')).toThrow()
  })
  it('tracks real delivery receipts and does not silently resend after restart', async () => {
    await start(); await active()
    const messageId = '22222222222222222222222222222222'
    const send = vi.spyOn(deps, 'send')
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledWith('agent-1', 'Make it taller', messageId)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'unknown' })]))
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledTimes(1)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'started' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'started' })]))
  })
  it('recovers a result notification saved before dispatch without rerunning work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    await service.finish(id, 'a', 1, 'verified result', [])
    service.stop()
    const file = join(deps.stateDir, `${id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.messages.at(-1).delivery = 'pending' // crash between durable result and dispatch
    writeFileSync(file, JSON.stringify(saved))
    sent.length = 0
    service = new OrchestratorService(deps)
    expect(tasks()[0].state).toBe('succeeded')
    service.snapshot(id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('verified result')
    expect(launches).toHaveLength(2)
  })
  it('keeps assistant turns separate even when a user message arrives mid-stream', async () => {
    await start(); await active()
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'First ' } })
    service.chat(id, '33333333333333333333333333333333', 'New detail')
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'reply.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1' })
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Second reply.' } })
    expect((service.snapshot(id).messages as Array<{ role: string; text: string }>).filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['First reply.', 'Second reply.'])
  })
  it('steers the current worker once and rejects stale or finished attempts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    const send = vi.spyOn(deps, 'send')
    const messageId = '44444444444444444444444444444444'
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(a.agentId, expect.stringContaining('Use millimeters'), messageId)
    expect(launches).toHaveLength(2)
    expect(() => service.steer(id, 'a', 2, messageId, 'Too late')).toThrow(/older attempt/)
    await service.finish(id, 'a', 1, 'done', [])
    expect(() => service.steer(id, 'a', 1, '55555555555555555555555555555555', 'Change it')).toThrow(/revision task/)
  })
  it('revokes only this project’s queued receipts when stopped', async () => {
    await start(); await active()
    const cancelDelivery = deps.cancelDelivery = vi.fn(() => true)
    const messageId = '66666666666666666666666666666666'
    service.chat(id, messageId, 'Queued correction')
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.cancel(id)
    expect(cancelDelivery).toHaveBeenCalledExactlyOnceWith(messageId)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'failed' })]))
  })
  it('does not race a retry against a worker still being created', async () => {
    await start(); await active()
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    service.cancel(id, 'a')
    expect(() => service.retry(id, 'a')).toThrow(/previous launch/)
    resolve({ agentId: 'late-worker' })
    await vi.waitFor(() => expect(cancelled).toContain('late-worker'))
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('reports invalid folders as an editable request refusal', async () => {
    expect(await orchestratorRequest(service, { action: 'start', id, engine: 'claude', prompt: 'Hi', cwd: join(root, 'missing') })).toMatchObject({ error: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('exposes actionable wire errors without throwing or weakening validation', async () => {
    expect(await orchestratorRequest(service, { action: 'status', id: '../escape' })).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await orchestratorRequest(service, { action: 'status', id })).toMatchObject({ error: 'PROJECT_NOT_FOUND' })
    expect(await orchestratorRequest(service, { action: 'install' })).toMatchObject({ error: 'INVALID_REQUEST' })
  })
  it('deduplicates simultaneous creation after asynchronous folder validation', async () => {
    const spec = { id, engine: 'claude', prompt: 'Use this existing folder', cwd: root }
    await Promise.all([service.start(spec), service.start(spec)]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].cwd).toBe(join(realpathSync(root), '.harness-projects', id))
  })
  it('lists recent projects in order without exposing their full briefs', async () => {
    // Recency needs distinct timestamps even when CI completes both starts in one millisecond.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await start(); await active()
    clock.mockReturnValue(2000)
    const second = 'f'.repeat(32)
    await service.start({ id: second, engine: 'claude', prompt: 'A'.repeat(500) })
    await vi.waitFor(() => expect(service.snapshot(second).state).toBe('active'))
    clock.mockReturnValue(3000)
    service.chat(second, '1'.repeat(32), 'More detail')
    expect(service.list().map(r => r.id)).toEqual([second, id])
    expect(String(service.list()[0].prompt)).toHaveLength(160)
  })
  it('preserves corrupt state and refuses to overwrite its identity', async () => {
    mkdirSync(deps.stateDir, { recursive: true })
    const file = join(deps.stateDir, `${id}.json`)
    writeFileSync(file, '{not valid JSON')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(service.list()).toEqual([])
    await expect(start()).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    expect(readFileSync(file, 'utf8')).toBe('{not valid JSON')
    expect(launches).toHaveLength(0)
  })
  it('recovers interrupted director and worker launches conservatively', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.state = 'starting'; saved.directorId = null; saved.tasks[0].state = 'launching'
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id)).toMatchObject({ state: 'paused', directorAvailable: false, tasks: [{ state: 'blocked', uncertain: true }] })
    await expect(service.resume(id)).rejects.toThrow(/original director/)
    expect(launches).toHaveLength(2)
  })
  it.each([new Error('Engine not authenticated'), 'unknown process refusal'])('records a director creation failure without hiding it: %s', async failure => {
    deps.create = async () => { throw failure }
    await start()
    await vi.waitFor(() => expect(service.snapshot(id).state).toBe('failed'))
    expect(service.snapshot(id).error).toBe(failure instanceof Error ? failure.message : 'Director launch failed.')
  })
  it('never overwrites an existing workspace, even without a saved run', async () => {
    mkdirSync(join(deps.workspaceDir, id), { recursive: true })
    await expect(start()).rejects.toMatchObject({ code: 'WORKSPACE_EXISTS' })
    expect(launches).toHaveLength(0)
  })
  it('refuses unsupported engines and invalid folder forms before creation', async () => {
    await expect(service.start({ id, engine: 'codex', prompt: 'Test' })).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' })
    const file = join(root, 'file'); writeFileSync(file, 'not a directory')
    for (const cwd of ['relative/path', `${root}\n`, file]) await expect(service.start({ id, engine: 'claude', prompt: 'Test', cwd })).rejects.toMatchObject({ code: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('does not start cancelled work while its folder is being prepared', async () => {
    await start(); await active(); service.plan(id, [task('a')]); service.cancel(id, 'a')
    await vi.waitFor(() => expect((service as unknown as { launching: Set<string> }).launching.size).toBe(0))
    expect(tasks()[0].state).toBe('cancelled'); expect(launches).toHaveLength(1)
  })
  it('handles a removed harness without mistaking it for an uncertain spawn', async () => {
    await start(); await active(); service.plan(id, [task('a')]); deps.catalog = () => []
    await vi.waitFor(() => expect(tasks()[0].state).toBe('failed'))
    expect(tasks()[0]).toMatchObject({ uncertain: false, error: expect.stringContaining('no longer installed') })
    expect(launches).toHaveLength(1)
  })
  it('can run general-purpose work, resume, and add a new revision after completion', async () => {
    await start(); await active(); service.plan(id, [task('notes', [], 'engine:claude')]); await running('notes')
    expect(launches[1].dsh).toBeNull()
    await service.finish(id, 'notes', 1, 'Verified notes', [])
    await service.finish(id, 'notes', 1, 'Same completed result', [])
    service.complete(id, 'Done'); service.chat(id, '2'.repeat(32), 'Create a revision')
    expect(service.snapshot(id).state).toBe('active')
    service.plan(id, [task('revision', ['notes'], 'engine:claude')]); await running('revision')
    service.cancel(id); await service.resume(id)
    expect(service.snapshot(id).state).toBe('active')
    expect(tasks()[0].state).toBe('succeeded'); expect(tasks()[1].state).toBe('cancelled')
    expect(launches).toHaveLength(3)
  })
  it('reports the same failure only once and rejects overlapping result commits', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b')]); await running('a'); await running('b')
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    expect(sent).toHaveLength(1)
    const first = service.finish(id, 'b', 1, 'Verified', [])
    await expect(service.finish(id, 'b', 1, 'Verified', [])).rejects.toMatchObject({ code: 'FINISH_IN_PROGRESS' })
    await first
  })
  it.each([new Error('Input route disappeared'), 'unknown dispatch failure'])('retains uncertain guidance instead of resending: %s', async failure => {
    await start(); await active(); deps.send = vi.fn(() => { throw failure })
    service.chat(id, '3'.repeat(32), 'Make it taller')
    service.chat(id, '3'.repeat(32), 'Make it taller')
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'unknown', deliveryReason: failure instanceof Error ? failure.message : 'Message delivery could not be confirmed.' })]))
  })
  it('leaves a recovered pending receipt pending when no director was recorded', async () => {
    await start(); await active(); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; saved.messages.push({ id: '4'.repeat(32), role: 'system', text: 'Saved result', at: Date.now(), delivery: 'pending' })
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
    expect(sent).toHaveLength(0)
  })
  it('flushes coalesced transcript changes and bounds retained messages', async () => {
    await start(); await active()
    for (let i = 0; i < 205; i++) {
      service.ingest({ type: 'turn_started', agentId: 'agent-1' })
      service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: `Reply ${i}` } })
    }
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'Connection lost' } })
    service.ingest({ type: 'unknown', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', replay: true, payload: { content: 'duplicate replay' } })
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(deps.stateDir, `${id}.json`), 'utf8')).error).toBe('Connection lost'))
    expect(service.snapshot(id).messages).toHaveLength(200)
    service.delivery({ deliveryId: 'missing', sessionId: 'not-this-project', state: 'rejected' })
    service.stop()
    const before = service.snapshot(id)
    service.delivery({ deliveryId: 'missing', sessionId: 'agent-1', state: 'started' })
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'ignored after shutdown' } })
    expect(service.snapshot(id)).toEqual(before)
  })
  it('pauses after a real background storage failure without duplicating the agent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start()
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try {
      resolve({ agentId: 'created-before-storage-failure' })
      await vi.waitFor(() => expect(service.snapshot(id).state).toBe('paused'))
      expect(service.snapshot(id).error).toMatch(/background error/)
    } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).directorId).toBe('created-before-storage-failure')
  })
  it('keeps cancellation authoritative when director creation later rejects', async () => {
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    await start(); service.plan(id, [task('queued-before-director')]); service.cancel(id)
    reject(new Error('Spawn rejected after cancellation'))
    await vi.waitFor(() => expect(service.snapshot(id).error).toBe('Spawn rejected after cancellation'))
    expect(service.snapshot(id).state).toBe('cancelled')
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('keeps cancellation authoritative when worker creation later rejects', async () => {
    await start(); await active()
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    service.cancel(id, 'a'); reject(new Error('Late spawn refusal'))
    await vi.waitFor(() => expect((service as unknown as { launching: Set<string> }).launching.size).toBe(0))
    expect(tasks()[0]).toMatchObject({ state: 'cancelled', uncertain: false })
  })
  it('does not downgrade a very fast worker result while creation is returning', async () => {
    await start(); await active()
    deps.create = async () => {
      await service.finish(id, 'fast', 1, 'Already verified', [])
      return { agentId: 'fast-worker' }
    }
    service.plan(id, [task('fast')])
    await vi.waitFor(() => expect(tasks()[0].agentId).toBe('fast-worker'))
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes non-Error worker failures and explicit input rejection', async () => {
    await start(); await active()
    deps.create = async () => { throw 'untyped refusal' }
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].error).toBe('Could not start this specialist.')
    const receipt = '9'.repeat(32)
    service.chat(id, receipt, 'Explain the blocker')
    service.delivery({ deliveryId: receipt, sessionId: 'agent-1', state: 'rejected', reason: 'Input route closed' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: receipt, delivery: 'failed', deliveryReason: 'Input route closed' })]))
  })
  it('preserves orphaned worker results without inventing a director', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    await service.finish(id, 'a', 1, 'Verified despite disconnected director', [])
    expect(tasks()[0].state).toBe('succeeded'); expect(sent).toHaveLength(0)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
  })
  it('does not lose a committed result if staging cleanup itself fails', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    vi.mocked(filesystem.rm).mockRejectedValueOnce(new Error('Cleanup refused'))
    await service.finish(id, 'a', 1, 'Verified', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes untyped private-state and background notification failures', async () => {
    await start(); await active(); service.stop()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(privateState, 'readPrivateStateFile').mockImplementationOnce(() => { throw 'untyped state failure' })
    service = new OrchestratorService(deps); expect(service.list()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid state'))
    service.stop(); service = new OrchestratorService(deps)
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw 'untyped observer failure' } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = 'e'.repeat(32)
    await service.start({ id: other, engine: 'claude', prompt: 'Another project' })
    await vi.waitFor(() => expect(service.snapshot(other).state).toBe('paused'))
    expect(service.snapshot(other).error).toContain('unknown error')
  })
  it('finishes a 64-task mixed-engine graph with bounded parallelism and verified fan-in', async () => {
    deps.supportsEngine = engine => ['claude', 'codex', 'opencode'].includes(engine)
    deps.catalog = () => ['cad', 'blender', 'video', 'research'].map((name, i) => ({
      id: `test/${name}`, name, description: `Synthetic ${name}`, engine: ['codex', 'claude', 'opencode'][i % 3], viewer: i !== 3,
    }))
    await service.start({ id, engine: 'claude', prompt: 'Stress-test a creative fan-out/fan-in project', parallelism: 6 }); await active()
    const graph = Array.from({ length: 64 }, (_, i) => task(`work-${i}`, i < 6 ? [] : [...new Set([`work-${i - 6}`, `work-${Math.floor((i - 6) / 2)}`])], `test/${['cad', 'blender', 'video', 'research'][i % 4]}`))
    service.plan(id, graph.slice(0, 32)); service.plan(id, graph.slice(32))
    expect(() => service.plan(id, [task('one-too-many')])).toThrow(/64 tasks/)
    let finished = 0, checkedInputs = 0
    while (finished < 64) {
      await vi.waitFor(() => expect(tasks().some(t => t.state === 'running')).toBe(true))
      const batch = tasks().filter(t => t.state === 'running')
      expect(tasks().filter(t => ['running', 'launching'].includes(t.state)).length).toBeLessThanOrEqual(6)
      for (const current of batch) {
        for (const parent of current.dependsOn) {
          expect(readFileSync(join(current.cwd, 'inputs', parent, 'result.txt'), 'utf8')).toBe(`Verified ${parent}`)
          checkedInputs++
        }
        writeFileSync(join(current.cwd, 'result.txt'), `Verified ${current.id}`)
        await service.finish(id, current.id, current.attempt, `Checked ${current.dependsOn.length} upstream contracts`, ['result.txt'])
        finished++
      }
    }
    expect(checkedInputs).toBeGreaterThan(100)
    expect(new Set(launches.slice(1).map(l => l.engine))).toEqual(new Set(['claude', 'codex', 'opencode']))
    expect(launches).toHaveLength(65)
    service.complete(id, 'All 64 task results and pinned input contracts verified')
    expect(service.snapshot(id).state).toBe('completed')
  }, 30_000)
})

const sh: StepSpawner = (script, opts) => spawn('/bin/sh', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
// A descendant that ignores SIGTERM, with its output redirected so the step's pipes close without it.
const steps = (...tasks: object[]): string => JSON.stringify({ spec: 1, name: 'demo', tasks }) // JSON is YAML: no quoting puzzles
const stubborn = (file: string) => `sh -c 'trap "" TERM; echo $$ > "${file}"; while :; do sleep 1; done' >/dev/null 2>&1 &`

describe('flow runs', () => {
  let root: string, project: string, service: OrchestratorService, deps: OrchestratorDependencies
  let launches: Parameters<OrchestratorDependencies['create']>[0][], agents: Set<string>, cancelled: string[], sends: [string, string][]
  const flowId = 'abcdefabcdefabcdefabcdefabcdef12'
  const snap = () => service.snapshot(flowId) as unknown as Run & { tasks: Task[] }
  const state = (taskId: string) => snap().tasks.find(t => t.id === taskId)!
  const until = async (taskId: string, wanted: Task['state'], attempt?: number): Promise<Task> => {
    await vi.waitFor(() => expect(state(taskId)).toMatchObject({ state: wanted, ...(attempt ? { attempt } : {}) }), { timeout: 5000 })
    return state(taskId)
  }
  const startFlow = (source: string, inputs: Record<string, string> = {}) =>
    service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, '.harness/flows/demo.yaml') }, inputs })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestrator-flow-')); project = join(root, 'project'); mkdirSync(project)
    launches = []; agents = new Set(); cancelled = []; sends = []
    deps = {
      stateDir: join(root, 'state'), workspaceDir: join(root, 'projects'), command: 'harness orchestrator', spawnStep: sh,
      supportsEngine: e => e === 'claude' || e === 'codex',
      catalog: () => [{ id: 'test/cad', name: 'cad', description: 'cad', engine: 'claude', viewer: true }],
      create: async input => { launches.push(input); const agentId = `agent-${launches.length}`; agents.add(agentId); return { agentId } },
      send: (agent, text) => { sends.push([agent, text]) }, cancel: agent => { cancelled.push(agent) },
      agent: agent => agents.has(agent) ? {} : null,
    }
    service = new OrchestratorService(deps)
  })
  const leftovers: number[] = [], others: OrchestratorService[] = []
  afterEach(() => {
    vi.mocked(fs.writeFileSync).mockReset() // back to the real write
    for (const other of others.splice(0)) other.stop()
    service.stop(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
    for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  })
  const pidIn = async (file: string): Promise<number> => {
    const pid = await vi.waitFor(() => { const text = readFileSync(file, 'utf8'); expect(text).toMatch(/^\d+\n$/); return Number(text) }, { timeout: 5000 })
    leftovers.push(pid)
    return pid
  }

  it('runs a pinned graph without a director and completes it', async () => {
    const source = `spec: 1
name: demo
inputs: { word: { required: true } }
tasks:
  - { id: make, run: 'printf "%s" "$HARNESS_INPUT_WORD" > word.txt; echo "$HARNESS_PROJECT_DIR|$HARNESS_FLOW_DIR|$HARNESS_TASK_ID|$HARNESS_ATTEMPT"' }
  - { id: check, run: 'cat inputs/make/stdout.log', depends_on: [make] }
`
    await startFlow(source, { word: '$(id)' })
    const done = await vi.waitFor(() => { expect(snap().state).toBe('completed'); return snap() }, { timeout: 5000 })
    expect(launches).toHaveLength(0)
    expect(done).toMatchObject({ directorId: null, error: null, cwd: realpathSync(project), flow: { name: 'demo', inputs: { word: '$(id)' }, warnings: [] } })
    expect(done.flow!.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(done.root, 'flow.yaml'), 'utf8')).toBe(source)
    const make = done.tasks[0]
    expect(make).toMatchObject({ state: 'succeeded', harness: 'run', pid: expect.any(Number), promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(make.artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    expect(readFileSync(join(make.cwd, 'word.txt'), 'utf8')).toBe('$(id)')
    expect(done.tasks[1].summary).toContain(`${realpathSync(project)}|${join(project, '.harness/flows')}|make|1`)
    expect(done.messages.every(m => m.delivery === undefined)).toBe(true)
    expect(done.messages.at(-1)!.text).toBe('Flow demo completed: 2 tasks succeeded.')
  })
  it('pins a JSON flow as flow.json, records the name, and compiles again from the copy', async () => {
    const source = '{"spec":1,"name":"demo","tasks":[{"id":"a","run":"true"}]}'
    await service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, 'demo.json') } })
    await until('a', 'succeeded')
    expect(snap().flow!.source).toBe('flow.json')
    expect(readFileSync(join(snap().root, 'flow.json'), 'utf8')).toBe(source)
    expect(existsSync(join(snap().root, 'flow.yaml'))).toBe(false)
    const pinned = join(snap().root, snap().flow!.source!)
    expect(compileFlow(parseFlowSource(readFileSync(pinned, 'utf8'), pinned), {}).tasks).toEqual(compileFlow(parseFlowSource(source, 'demo.json'), {}).tasks)
  })
  it('pins any other flow as flow.yaml and records it', async () => {
    await startFlow('spec: 1\nname: demo\ntasks: [{ id: a, run: "true" }]\n')
    await until('a', 'succeeded')
    expect(snap().flow!.source).toBe('flow.yaml')
    expect(existsSync(join(snap().root, 'flow.json'))).toBe(false)
  })
  it('names the pinned copy by the source extension, ignoring case', () => {
    expect([pinnedFlowName('/p/a.json'), pinnedFlowName('/p/A.JSON'), pinnedFlowName('/p/a.yaml'), pinnedFlowName('/p/a.yml'), pinnedFlowName('/p/json')])
      .toEqual(['flow.json', 'flow.json', 'flow.yaml', 'flow.yaml', 'flow.yaml'])
  })
  it('uses the run root as the project folder when none was chosen, and says when a step printed nothing', async () => {
    await service.start({ id: flowId, engine: 'claude', prompt: 'Flow demo', flow: { source: `spec: 1\nname: demo\ntasks: [{ id: a, run: 'test -f "$HARNESS_PROJECT_DIR/flow.yaml"' }]\n`, path: '/flows/demo.yaml' } })
    expect(await until('a', 'succeeded')).toMatchObject({ summary: 'Exited 0.' })
    expect(snap().cwd).toBeUndefined()
  })
  it('fails a step with its exit code and stops the flow with a readable error', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'echo nope >&2; exit 4' }\n  - { id: after, run: 'true', depends_on: [bad] }\n`)
    expect((await until('bad', 'failed')).error).toBe('exit 4: nope')
    // A failed attempt keeps its logs as artifacts once its process is gone.
    await vi.waitFor(() => expect(state('bad').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']))
    expect(readFileSync(join(snap().root, 'artifacts', 'bad', 'attempt-1', 'stderr.log'), 'utf8')).toBe('nope\n')
    await until('after', 'blocked')
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: bad (failed), after (blocked). Retry a task or cancel the project.'))
    expect(snap().state).toBe('active')
    service.retry(flowId, 'bad')
    await until('bad', 'failed', 2)
  })
  it('drops the stopped-flow advice once the project is cancelled', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'exit 4' }\n`)
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: bad (failed). Retry a task or cancel the project.'))
    service.cancel(flowId)
    expect(snap()).toMatchObject({ state: 'cancelled', error: null })
  })
  it('launches agent tasks on any supported engine and refuses director-only operations', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: 'engine:codex', prompt: 'Write a.md', outputs: { files: [a.md] } }\n  - { id: b, harness: test/cad, prompt: 'Model it', timeout: 5m }\n`)
    await until('a', 'running'); await until('b', 'running')
    expect(launches.map(l => l.engine).sort()).toEqual(['claude', 'codex'])
    expect(state('a')).toMatchObject({ engine: 'codex' })
    expect(state('b')).toMatchObject({ engine: 'claude' })
    expect(() => service.plan(flowId, [task('x')])).toThrow(expect.objectContaining({ code: 'FLOW_PINNED' }))
    expect(() => service.chat(flowId, 'c'.repeat(32), 'hi')).toThrow(expect.objectContaining({ code: 'DIRECTOR_UNAVAILABLE' }))
    service.cancel(flowId, 'b')
    await service.resume(flowId)
    expect(snap().state).toBe('active')
  })
  it('validates the whole flow before creating anything', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: missing/x, prompt: p }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): missing\/x is not an installed harness/) })
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: "engine:gemini", prompt: p }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): engine:gemini cannot run/) })
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, run: "echo $inputs.x" }]\n')).rejects.toMatchObject({ code: 'INVALID_FLOW' })
    expect(existsSync(join(project, '.harness-projects'))).toBe(false)
  })
  it('creates nothing, not even the state folder, for a flow that does not compile', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: test/none, prompt: hi }]\n')).rejects.toThrow(/demo\.yaml:3:\d+: tasks\[0\] \(a\): test\/none is not an installed harness/)
    expect(existsSync(deps.stateDir)).toBe(false)
    expect(existsSync(join(project, '.harness-projects'))).toBe(false)
  })
  it('names the position of an engine this daemon cannot run', async () => {
    await expect(startFlow('spec: 1\nname: demo\ntasks: [{ id: a, harness: engine:grok, prompt: hi }]\n')).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: expect.stringMatching(/demo\.yaml:3:\d+: tasks\[0\] \(a\): engine:grok cannot run orchestrator work here\./) })
  })
  it('keeps ENGINE_UNSUPPORTED for a start engine this daemon cannot run, with a position when the file declares it', async () => {
    const start = (source: string) => service.start({ id: flowId, engine: 'cursor', prompt: 'Flow demo', cwd: project, flow: { source, path: join(project, '.harness/flows/demo.yaml') } })
    await expect(start('spec: 1\nname: demo\nengine: cursor\ntasks: [{ id: a, run: "true" }]\n')).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED', message: expect.stringContaining('demo.yaml:3:9: engine: cursor cannot run orchestrator work here.') })
    await expect(start('spec: 1\nname: demo\ntasks: [{ id: a, run: "true" }]\n')).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED', message: expect.stringMatching(/^[^:]*demo\.yaml: engine: cursor cannot run/) })
    expect(existsSync(deps.stateDir)).toBe(false)
  })
  it('lets a harness problem decide the code when the engine is also unsupported', async () => {
    await expect(service.start({ id: flowId, engine: 'cursor', prompt: 'Flow demo', flow: { source: 'spec: 1\nname: demo\ntasks: [{ id: a, harness: missing/x, prompt: p }]\n', path: join(project, 'demo.yaml') } })).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' })
  })
  it('keeps flow-only fields away from director plans', async () => {
    await service.start({ id, engine: 'claude', prompt: 'Make something' })
    await vi.waitFor(() => expect(service.snapshot(id).state).toBe('active'))
    for (const extra of [{ run: 'rm -rf ~' }, { outputs: { files: ['x'] } }, { timeoutMs: 1000 }, { retry: { maxAttempts: 1 } },
      { when: 'x == 1' }, { triggerRule: 'all_done' }, { approval: { message: 'ok' } }, { cancel: 'stop' },
      { loop: { untilRun: 'true', maxIterations: 2 } }, { idleTimeoutMs: 5000 }, { retry: { maxAttempts: 2, delayMs: 2000 } }]) {
      expect(() => service.plan(id, [{ ...task('a', [], 'test/cad'), ...extra }])).toThrow(expect.objectContaining({ code: 'FLOW_ONLY' }))
    }
    expect(() => service.plan(id, [task('a', [], 'engine:codex')])).toThrow(expect.objectContaining({ code: 'HARNESS_UNAVAILABLE' }))
  })
  it('stops a running step on cancel without recording a result', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    const exited = (service as unknown as { steps: Map<string, { handle: { done: Promise<unknown> } }> }).steps.values().next().value!.handle.done
    service.cancel(flowId)
    await exited
    expect(state('slow')).toMatchObject({ state: 'cancelled', artifacts: [] })
  })
  it('records a step whose shell could not start', async () => {
    deps.spawnStep = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    expect(await until('a', 'failed')).toMatchObject({ error: 'the shell could not be found (ENOENT)' })
    expect(state('a').pid).toBeUndefined()
  })
  it('never retries a step whose shell could not start', async () => {
    const spawner = vi.fn<StepSpawner>(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) })
    deps.spawnStep = spawner
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true', retry: { max_attempts: 2 } }]\n`)
    await until('a', 'failed')
    await vi.waitFor(() => expect(snap().error).toBe('Flow stopped: a (failed). Retry a task or cancel the project.'))
    expect(state('a').attempt).toBe(1)
    expect(spawner).toHaveBeenCalledTimes(1)
  })
  it('stops the process and the agent on cancel even when the state cannot be saved', async () => {
    await startFlow(steps({ id: 's', run: 'sleep 30' }, { id: 'a', harness: 'test/cad', prompt: 'p' }))
    const pid = (await until('s', 'running')).pid!, agent = (await until('a', 'running')).agentId
    diskFull()
    expect(() => service.cancel(flowId)).toThrow(/ENOSPC/)
    expect(cancelled).toEqual([agent])
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 })
  })
  it('stops every step on a daemon stop even when saving fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's1', run: 'sleep 30' }, { id: 's2', run: 'sleep 30' }))
    const pids = [(await until('s1', 'running')).pid!, (await until('s2', 'running')).pid!]
    diskFull()
    expect(() => service.stop()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(`[orchestrator] could not save ${flowId}: ENOSPC: no space left on device, write`)
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 2000 })
  })
  it('records steps it stopped on a graceful daemon stop', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    service.stop()
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    expect(saved.tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('pauses with the step result kept when its artifacts cannot be saved, and saves it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await vi.waitFor(() => expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('disk full') }), { timeout: 5000 })
    expect(liveTask('a').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId)
    expect(liveTask('a').state).toBe('succeeded')
  })
  it('waits for an explicit finish that fails, then settles the step itself', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'sleep 0.3' }]\n`)
    await until('a', 'running')
    const exited = (service as unknown as { steps: Map<string, { handle: { done: Promise<unknown> } }> }).steps.values().next().value!.handle.done
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async () => { await gate; throw new Error('disk full') })
    const explicit = service.finish(flowId, 'a', 1, 'by hand', ['stdout.log']).catch((error: Error) => error)
    await exited
    release()
    expect(await explicit).toMatchObject({ message: 'disk full' })
    await until('a', 'succeeded')
  })
  it('starts nothing when the daemon stops while a step is being prepared', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const spawned = vi.fn(sh)
    deps.spawnStep = spawned
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    vi.mocked(filesystem.mkdir).mockImplementationOnce(async (...args: Parameters<typeof realMkdir>) => { await gate; return realMkdir(...args) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    service.stop()
    release()
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(spawned).not.toHaveBeenCalled()
    expect(launches).toHaveLength(0)
  })
  it('does not record success for a step whose result is being saved when the daemon stops', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const inRename = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { reached(); await gate; return realRename(from, to) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, run: 'true' }]\n`)
    await inRename
    service.stop()
    release()
    await vi.waitFor(() => expect(internals().finishing.size).toBe(0))
    expect(state('a').state).not.toBe('succeeded')
  })
  it('keeps a cancelled step cancelled when the daemon stops right after', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'sleep 30' }]\n`)
    await until('slow', 'running')
    service.cancel(flowId)
    service.stop()
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    expect(saved.tasks[0]).toMatchObject({ state: 'cancelled' })
  })

  it('finishes an agent task when its turn ends with the declared outputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'], verdict: ready } }\n  - { id: check, run: 'cat inputs/part/part.step', depends_on: [part] }\n`)
    const part = await until('part', 'running')
    const end = (payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) => service.ingest({ type: 'turn_ended', agentId: part.agentId, payload, ...extra })
    end() // no payload at all
    await vi.waitFor(() => expect(snap().messages.at(-1)!.text).toBe('Task part attempt 1: turn ended. Outputs missing: *.step, .harness/verdict.json with ready: true'))
    writeFileSync(join(part.cwd, 'part.step'), 'cad v1')
    mkdirSync(join(part.cwd, '.harness')); writeFileSync(join(part.cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: true }))
    const checks = vi.mocked(outputsModule.checkOutputs).mock.calls.length
    end({ aborted: true }); end({}, { replay: true }); service.ingest({ type: 'text_delta', agentId: part.agentId, payload: { content: 'x' } })
    expect(vi.mocked(outputsModule.checkOutputs).mock.calls.length).toBe(checks) // none of these is a finished turn
    end({}); end({}) // a duplicate end is harmless
    await until('part', 'succeeded')
    expect(state('part')).toMatchObject({ summary: 'Outputs present: part.step', artifacts: [expect.objectContaining({ path: 'part.step' })] })
    await vi.waitFor(() => expect(snap().state).toBe('completed'))
  })
  it('leaves explicit finish working and ignores turns of tasks without outputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: note, harness: test/cad, prompt: 'Write', timeout: 1h }\n`)
    const note = await until('note', 'running')
    const checks = vi.mocked(outputsModule.checkOutputs).mock.calls.length
    service.ingest({ type: 'turn_ended', agentId: note.agentId, payload: {} })
    expect(vi.mocked(outputsModule.checkOutputs).mock.calls.length).toBe(checks)
    await service.finish(flowId, 'note', 1, 'Done by hand', [])
    expect(state('note').state).toBe('succeeded')
  })
  it('keeps the task running when an output changes while it is saved', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'] } }\n`)
    const part = await until('part', 'running')
    writeFileSync(join(part.cwd, 'part.step'), 'v1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); writeFileSync(join(part.cwd, 'part.step'), 'v2, still writing') })
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed during handoff')))
    expect(state('part').state).toBe('running')
  })
  it('logs, and keeps the task running, when the outputs cannot be checked', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: part, harness: test/cad, prompt: 'Model it', outputs: { files: ['*.step'] } }\n`)
    const part = await until('part', 'running')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(outputsModule.checkOutputs).mockRejectedValueOnce(new OrchestratorError('OUTPUTS_TOO_LARGE', 'too many'))
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] part attempt 1: too many'))
    vi.mocked(outputsModule.checkOutputs).mockRejectedValueOnce('boom')
    service.ingest({ type: 'turn_ended', agentId: part.agentId, payload: {} })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestrator] part attempt 1: outputs not checked'))
    expect(state('part').state).toBe('running')
  })

  const internals = () => service as unknown as {
    runs: Map<string, Run>; deadlines: Map<string, unknown>; retryTimers: Map<string, unknown>; idleTimers: Map<string, unknown>; checks: Map<string, unknown>; steps: Map<string, { handle: { done: Promise<unknown> }; uncertain?: string }>
    expire(run: Run, task: Task, attempt: number): Promise<void>
    commit(run: Run, mutate: (draft: Run) => void): void
    appendMessage(run: Run, role: 'user' | 'assistant' | 'system', text: string): Run['messages'][number]
    finishing: Map<string, unknown>; launching: Map<string, unknown>; reconciling: Map<string, Promise<void>>
    pump(run: Run): void; pause(run: Run, error: unknown): void
    exclusive<T>(r: Run, t: Task, n: number, b: () => Promise<T>): Promise<T>
    pending: Map<string, { task: Task; at: number; source: string }>
    fenceUncertain(run: Run, task: Task, attempt: number, error: string, source: 'exit' | 'check', at: number): Promise<boolean>
  }
  const live = () => internals().runs.get(flowId)! // the service's own objects: reading them never pumps
  const liveTask = (taskId: string) => live().tasks.find(t => t.id === taskId)!
  const onDisk = () => JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8')) as Run
  /** A shell fragment that waits until the test opens the gate (a file in the project folder): ordering without fixed delays. */
  const gate = (name: string): { run: string; open(): void } => ({
    run: `while [ ! -e "$HARNESS_PROJECT_DIR/${name}.open" ]; do sleep 0.05; done`,
    open: () => writeFileSync(join(project, `${name}.open`), ''),
  })
  /** Records what disk and memory hold at each notification. */
  const watchChanges = () => {
    const seen: { revision: number; disk: number; live: number }[] = []
    deps.changed = (_id, revision) => { seen.push({ revision, disk: onDisk().revision, live: live().revision }) }
    return seen
  }
  const objectsOf = (value: unknown, found = new Set<object>()): Set<object> => {
    if (value && typeof value === 'object' && !found.has(value)) { found.add(value); for (const child of Object.values(value)) objectsOf(child, found) }
    return found
  }

  it('runs operations on one attempt one after another, and registers at once when nobody owns it', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const order: string[] = []
    let release!: () => void
    const first = internals().exclusive(live(), liveTask('a'), 1, async () => { order.push('first in'); await new Promise<void>(r => { release = r }); order.push('first out') })
    expect(internals().finishing.size).toBe(1) // registered before the first await
    const second = internals().exclusive(live(), liveTask('a'), 1, async () => { order.push('second') })
    await vi.waitFor(() => expect(order).toEqual(['first in']))
    release(); await Promise.all([first, second])
    expect(order).toEqual(['first in', 'first out', 'second'])
    expect(internals().finishing.size).toBe(0)
  })
  it('commits a transition into the same objects, or not at all', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').pid).toEqual(expect.any(Number)))
    const run = live(), task = liveTask('a'), revision = run.revision
    expect(run.cwd).toBeDefined()
    const dirty = () => (internals() as unknown as { dirty: Map<string, unknown> }).dirty
    const changed = (internals() as unknown as { changed(r: Run, durable: boolean): void }).changed.bind(service)
    changed(run, false) // leaves a dirty-save timer
    const seen = watchChanges()
    internals().commit(run, draft => { draft.tasks[0].summary = 'x'; delete draft.tasks[0].pid; delete draft.cwd; draft.error = 'note' })
    expect(dirty().size).toBe(0) // the commit carried that change too
    expect(seen).toEqual([{ revision: revision + 2, disk: revision + 2, live: revision + 2 }]) // once, after disk and memory agree
    expect(liveTask('a')).toBe(task)
    expect(task).toMatchObject({ summary: 'x' }); expect(task.pid).toBeUndefined()
    expect(run.cwd).toBeUndefined()
    expect(run).toMatchObject({ error: 'note', revision: revision + 2 })
    expect(onDisk().tasks[0].summary).toBe('x')

    // A failed save leaves the live run exactly as it was, nested data included, and keeps the pending dirty save.
    run.error = 'unsaved'; changed(run, false)
    const pending = dirty().get(flowId)
    expect(pending).toBeDefined()
    const before = JSON.stringify(run), tasks = [...run.tasks]
    seen.length = 0
    diskFull()
    expect(() => internals().commit(run, draft => {
      const shared = objectsOf(run)
      expect([...objectsOf(draft)].filter(o => shared.has(o))).toEqual([]) // the draft shares nothing with the live run
      draft.tasks[0].summary = 'lost'; draft.tasks[0].dependsOn.push('z'); draft.tasks[0].inputs.z = 1
      draft.tasks[0].artifacts.push({ path: 'p', size: 1, sha256: 'f'.repeat(64) } as Task['artifacts'][number])
      draft.messages.push({ id: 'm', role: 'system', text: 'lost', at: 1 }); draft.flow!.inputs.extra = 'lost'
    })).toThrow(/ENOSPC/)
    expect(JSON.stringify(run)).toBe(before)
    expect(run.tasks).toEqual(tasks); run.tasks.forEach((t, i) => expect(t).toBe(tasks[i]))
    expect(dirty().get(flowId)).toBe(pending)
    expect(seen).toEqual([])
    vi.mocked(fs.writeFileSync).mockReset()
    await vi.waitFor(() => expect(onDisk()).toMatchObject({ error: 'unsaved', revision: run.revision })) // the kept timer saves it
    expect(dirty().size).toBe(0)

    expect(() => internals().commit(run, () => internals().commit(run, () => {}))).toThrow(expect.objectContaining({ code: 'COMMIT_NESTED' }))
    expect(seen).toEqual([])
    expect(live().tasks[0]).toBe(task) // the task array still holds the same objects
  })
  it('publishes tasks by id and refuses a draft that changes the task list', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }, { id: 'b', run: 'sleep 30' }))
    await vi.waitFor(() => expect(live().tasks.map(t => t.state)).toEqual(['running', 'running']))
    const run = live(), a = liveTask('a'), b = liveTask('b'), revision = run.revision
    const seen = watchChanges()
    internals().commit(run, draft => { draft.tasks.reverse(); draft.tasks[0].summary = 'first' })
    expect(run.tasks[0]).toBe(b); expect(run.tasks[1]).toBe(a) // the draft's order, the live objects
    expect(b.summary).toBe('first'); expect(a.summary).not.toBe('first')
    expect(seen).toEqual([{ revision: revision + 1, disk: revision + 1, live: revision + 1 }])
    seen.length = 0
    const before = JSON.stringify(run)
    const twin = (draft: Run) => ({ ...draft.tasks[0] })
    for (const mutate of [
      (draft: Run) => { draft.tasks.push({ ...twin(draft), id: 'c' }) },
      (draft: Run) => { draft.tasks[1] = twin(draft) },
      (draft: Run) => { draft.tasks.pop() },
    ]) {
      expect(() => internals().commit(run, mutate)).toThrow(expect.objectContaining({ code: 'COMMIT_TASKS' }))
      expect(JSON.stringify(run)).toBe(before)
      expect(onDisk().revision).toBe(revision + 1) // nothing was written
    }
    expect(run.tasks[0]).toBe(b); expect(run.tasks[1]).toBe(a)
    expect(seen).toEqual([])
  })
  it('keeps at most 200 messages, also in a committed draft', async () => {
    await startFlow(steps({ id: 'a', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    internals().commit(live(), draft => { for (let i = 0; i < 250; i++) internals().appendMessage(draft, 'system', `m${i}`) })
    expect(live().messages).toHaveLength(200)
    expect(Run.parse(JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))).messages.at(-1)!.text).toBe('m249')
  })
  it('keeps the verdict of a finished attempt, failed ones included', async () => {
    writeFileSync(join(project, 'verdict.sh'), `mkdir -p .harness && printf '%s' '{"spec":1,"ready":true,"findings":[{"severity":"warning"}]}' > .harness/verdict.json\n`)
    await startFlow(steps(
      { id: 'ok', run: 'sh "$HARNESS_PROJECT_DIR/verdict.sh"' },
      { id: 'bad', run: 'sh "$HARNESS_PROJECT_DIR/verdict.sh"; exit 3' },
      { id: 'none', run: 'true' },
    ))
    await vi.waitFor(() => { expect(liveTask('ok').state).toBe('succeeded'); expect(liveTask('none').state).toBe('succeeded'); expect(liveTask('bad').state).toBe('failed') })
    expect(liveTask('ok').verdict).toEqual({ ready: true, errors: 0, warnings: 1 })
    expect(liveTask('bad').verdict).toEqual({ ready: true, errors: 0, warnings: 1 })
    expect(liveTask('none').verdict).toBeUndefined()
  })
  it('drops the verdict of an earlier attempt when its retry cannot start, so no condition reads it', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: review, harness: test/cad, prompt: p, retry: { max_attempts: 2 } }
  - { id: gate, run: 'true', depends_on: [review], trigger_rule: all_done, when: 'review.verdict.ready == true' }
`)
    await vi.waitFor(() => expect(liveTask('review').state).toBe('running'))
    const cwd = liveTask('review').cwd
    mkdirSync(join(cwd, '.harness')); writeFileSync(join(cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: true }))
    deps.create = async () => { throw new OrchestratorError('HARNESS_UNAVAILABLE', 'test/cad is no longer installed.') }
    await service.finish(flowId, 'review', 1, 'not ready yet', [], true)
    await vi.waitFor(() => expect(liveTask('review')).toMatchObject({ state: 'failed', attempt: 2, error: 'test/cad is no longer installed.' }))
    expect(liveTask('review').verdict).toBeUndefined()
    await vi.waitFor(() => expect(liveTask('gate').state).toBe('failed'))
    expect(liveTask('gate').error).toBe('review wrote no verdict; the condition review.verdict.ready == true cannot be evaluated.')
  })
  it('changes nothing when a result cannot be saved, and saves it on the next try', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    diskFull()
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(liveTask('a')).toMatchObject({ state: 'running', artifacts: [], summary: '' })
    expect(internals().deadlines.size).toBe(1)
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 succeeded'))).toBe(false)
    await service.finish(flowId, 'a', 1, 'done', ['out.txt']) // the folder renamed by the failed try is replaced
    expect(liveTask('a')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'out.txt' }] })
  })
  it('changes nothing when a reported failure cannot be saved, and saves it on the next try', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const revision = live().revision
    diskFull()
    await expect(service.finish(flowId, 'a', 1, 'broken', [], true)).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 1, error: null, summary: '' })
    expect(live().revision).toBe(revision)
    expect(internals().deadlines.size).toBe(1)
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 failed'))).toBe(false)
    expect(launches).toHaveLength(1) // no retry was started for a failure that was never taken
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    expect(onDisk().messages.some(m => m.text.startsWith('Task a attempt 1 failed. broken'))).toBe(true)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('pauses when a step failure cannot be saved, and retries it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: `[ "$HARNESS_ATTEMPT" = 1 ] && { ${g.run}; exit 1; }; sleep 30`, retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"failed"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk), { timeout: 5000 })
    expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 1 })
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(live().messages.some(m => m.text.startsWith('Task s attempt 1 failed. exit 1'))).toBe(true)
  })
  /** Holds the next verdict read until released. */
  const holdVerdictRead = () => {
    let release!: () => void, reading = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(async () => { reading = true; await gate; return undefined })
    return { release, reading: () => reading }
  }
  it.each(['cancel', 'stop'] as const)('does not stop or cancel anything for a timeout that a %s beat', async winner => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const hold = holdVerdictRead()
    const expiring = internals().expire(live(), liveTask('a'), 1)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    if (winner === 'cancel') service.cancel(flowId, 'a'); else service.stop()
    const before = [...cancelled]
    hold.release(); await expiring
    expect(cancelled).toEqual(before) // the agent that survives a daemon stop is not cancelled by the timeout
    if (winner === 'cancel') expect(liveTask('a').state).toBe('cancelled')
    expect(liveTask('a').error).not.toBe('Timed out after 1h.')
    expect(warn).not.toHaveBeenCalled()
  })
  it('writes nothing more for a result once its task is stopped during a wait', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(filesystem.stat).mockImplementationOnce(async path => { service.cancel(flowId, 'a'); return actual.stat(path) })
    vi.mocked(filesystem.copyFile).mockClear()
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(filesystem.copyFile).not.toHaveBeenCalled()
    expect(existsSync(join(live().root, 'artifacts'))).toBe(false)
  })
  it('does not save a result over a cancel that came during the staging cleanup', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    writeFileSync(join(liveTask('a').cwd, 'out.txt'), 'x')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let raced = false
    vi.mocked(filesystem.rm).mockImplementation(async (path, options) => {
      if (!raced && String(path).endsWith('.staging')) { raced = true; service.cancel(flowId, 'a') }
      return actual.rm(path, options)
    })
    await expect(service.finish(flowId, 'a', 1, 'done', ['out.txt'])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    expect(raced).toBe(true)
    expect(liveTask('a').state).toBe('cancelled')
    expect(onDisk().tasks[0].state).toBe('cancelled')
    expect(live().messages.some(m => m.text.startsWith('Task a attempt 1 succeeded'))).toBe(false)
  })
  it('still stops a timed-out worker when the retry it releases cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const agentId = liveTask('a').agentId
    diskFull()
    try { await internals().expire(live(), liveTask('a'), 1) } finally { vi.mocked(fs.writeFileSync).mockReset() }
    expect(cancelled).toEqual([agentId])
    // The timeout could not be saved: the run pauses with it kept, and resuming applies it and starts the retry.
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 1 })
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('runs what follows a reported result once, even when a change observer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw new Error('observer down') } }
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    expect(warn).toHaveBeenCalledWith('[orchestrator] change notification failed: observer down')
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(live().messages.filter(m => m.text.startsWith('Task a attempt 1 failed. '))).toHaveLength(1)
    expect(internals().deadlines.size).toBe(1) // only the new attempt's
  })
  it('takes an automatic failure once, even when a change observer fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: '[ "$HARNESS_ATTEMPT" = 1 ] && { sleep 0.3; exit 1; }; sleep 30', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw new Error('observer down') } }
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'running', attempt: 2 }), { timeout: 5000 })
    expect(warn).toHaveBeenCalledWith('[orchestrator] change notification failed: observer down')
    expect(live().messages.filter(m => m.text.startsWith('Task s attempt 1 failed. '))).toHaveLength(1)
  })
  it('times out a step, kills it, and retries it a bounded number of times', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: slow, run: 'echo "$HARNESS_ATTEMPT" >> "$HARNESS_PROJECT_DIR/attempts"; sleep 30', timeout: 1s, retry: { max_attempts: 2 } }]\n`)
    await until('slow', 'failed', 2)
    expect(state('slow').error).toBe('Timed out after 1s.')
    expect(readFileSync(join(project, 'attempts'), 'utf8')).toBe('1\n2\n')
    await vi.waitFor(() => expect(state('slow').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']))
    expect(existsSync(join(snap().root, 'artifacts', 'slow', 'attempt-1', 'stdout.log'))).toBe(true)
    expect(snap().messages.some(m => m.text === 'Task slow attempt 1 failed; retrying (attempt 2 of 2).')).toBe(true)
    // While the retry was due the flow was never reported as stopped.
    expect(snap().messages.filter(m => m.text.startsWith('Task slow attempt')).map(m => m.text.split('\n')[0])).toEqual([
      'Task slow attempt 1 failed. Timed out after 1s.', 'Task slow attempt 1 failed; retrying (attempt 2 of 2).', 'Task slow attempt 2 failed. Timed out after 1s.',
    ])
    expect(internals().deadlines.size).toBe(0)
  }, 15_000)
  it('times out an agent task, cancels its worker after winning, and retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h, retry: { max_attempts: 2 } }]\n`)
    const a = await until('a', 'running')
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10)
    await until('a', 'running', 2)
    expect(cancelled).toEqual([a.agentId])
    expect(snap().messages.some(m => m.text.includes('Timed out after 1h.'))).toBe(true)
  })
  it('lets a finish that is already saving win over the timeout', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    writeFileSync(join(a.cwd, 'out.txt'), 'x')
    let release!: () => void
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await new Promise<void>(r => { release = r }); return realCopy(from, to) })
    const finishing = service.finish(flowId, 'a', 1, 'done', ['out.txt'])
    const run = internals().runs.get(flowId)!
    const expiring = internals().expire(run, run.tasks[0], 1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await finishing; await expiring
    expect(state('a').state).toBe('succeeded')
    expect(cancelled).toEqual([])
    expect(internals().deadlines.size).toBe(0)
  })
  it('keeps the first automatic result that cannot be saved, and ignores the ones queued behind it while paused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, outputs: { files: [out.txt] }, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    writeFileSync(join(a.cwd, 'out.txt'), 'x')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const inRename = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(filesystem.rename).mockImplementationOnce(async () => { reached(); await gate; throw new Error('disk full') })
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // owns the attempt
    await inRename
    const checks = vi.mocked(outputsModule.checkOutputs)
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} }) // queues first
    await checks.mock.results.at(-1)!.value // its settle is now waiting
    const run = internals().runs.get(flowId)!
    const expiring = internals().expire(run, run.tasks[0], 1) // queues second
    release()
    await expiring
    await vi.waitFor(() => expect(internals().finishing.size).toBe(0))
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('disk full') })
    expect(liveTask('a').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    expect(cancelled).toEqual([])
    await service.resume(flowId) // the kept success was seen before the 1h deadline
    expect(liveTask('a').state).toBe('succeeded')
  })
  it('ignores an expiry that belongs to an older attempt', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('a', 'running')
    await service.finish(flowId, 'a', 1, 'nope', [], true)
    service.retry(flowId, 'a')
    await until('a', 'running', 2)
    const run = internals().runs.get(flowId)!
    await internals().expire(run, run.tasks[0], 1)
    expect(state('a')).toMatchObject({ state: 'running', attempt: 2 })
    expect(cancelled).toEqual([])
  })
  it('runs a failing worker at most max_attempts times in all, and never retries without retry', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, retry: { max_attempts: 3 } }, { id: b, harness: test/cad, prompt: p }, { id: c, harness: test/cad, prompt: p, retry: { max_attempts: 1 } }]\n`)
    for (const attempt of [1, 2, 3]) {
      await until('a', 'running', attempt)
      await service.finish(flowId, 'a', attempt, `gave up ${attempt}`, [], true)
    }
    for (const id of ['b', 'c']) {
      await until(id, 'running')
      await service.finish(flowId, id, 1, 'gave up', [], true)
    }
    expect(state('a')).toMatchObject({ state: 'failed', attempt: 3 })
    expect(state('b')).toMatchObject({ state: 'failed', attempt: 1 })
    expect(state('c')).toMatchObject({ state: 'failed', attempt: 1 })
    expect(launches).toHaveLength(5)
  })
  it('waits for a failed step to exit before retrying, and lets cancel or a manual retry take over', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: s, run: 'trap "" TERM; while :; do sleep 1; done', timeout: 1s, retry: { max_attempts: 2 } }]\n`)
    await until('s', 'failed', 1)
    const exited = internals().steps.values().next().value!.handle.done
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'TASK_STOPPING' }))
    service.cancel(flowId, 's') // drops the due retry; the failed attempt stays failed
    await exited
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(state('s')).toMatchObject({ state: 'failed', attempt: 1 })
    service.retry(flowId, 's')
    await until('s', 'running', 2)
  }, 15_000)
  it('starts a retry only once the failed attempt\'s leftovers are gone', async () => {
    const child = join(project, 'child.pid'), overlap = join(project, 'overlap')
    await startFlow(steps({ id: 's', run: `[ "$HARNESS_ATTEMPT" = 1 ] || { kill -0 "$(cat ${child})" 2>/dev/null && touch ${overlap}; exit 0; }; ${stubborn(child)} sleep 0.3; exit 1`, retry: { max_attempts: 2 } }))
    await pidIn(child)
    await until('s', 'succeeded', 2)
    expect(existsSync(overlap)).toBe(false)
  }, 15_000)
  it('kills steps outright on a daemon stop, leftovers that ignore SIGTERM included', async () => {
    const child = join(project, 'child.pid')
    await startFlow(steps({ id: 's', run: `${stubborn(child)} wait` }))
    const pid = await pidIn(child)
    service.stop()
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000 })
  })
  it('does not retry while the failed attempt is still launching', async () => {
    let finishLaunch!: () => void
    deps.create = async input => { launches.push(input); await new Promise<void>(r => { finishLaunch = r }); agents.add('late'); return { agentId: 'late' } }
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, retry: { max_attempts: 2 } }]\n`)
    await until('a', 'launching')
    await vi.waitFor(() => expect(finishLaunch).toBeTypeOf('function'))
    await service.finish(flowId, 'a', 1, 'reported early', [], true)
    expect(launches).toHaveLength(1)
    expect(state('a')).toMatchObject({ state: 'failed', attempt: 1 })
    finishLaunch()
    await until('a', 'launching', 2)
  })
  it('recovers after a crash: steps become uncertain, deadlines are enforced', async () => {
    await startFlow(steps({ id: 'slow', run: 'sleep 30' }, { id: 'agent', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'nopid', run: 'sleep 30' }))
    await vi.waitFor(() => { for (const id of ['slow', 'agent', 'nopid']) expect(liveTask(id).state).toBe('running') })
    const left = orphan() // stands in for slow's process, which outlived the crash
    const saved = onDisk()
    saved.tasks.find(t => t.id === 'slow')!.pid = left.pid
    saved.tasks.find(t => t.id === 'agent')!.deadline = Date.now() - 1
    delete saved.tasks.find(t => t.id === 'nopid')!.pid
    const agentId = liveTask('agent').agentId
    service.stop() // the original daemon is gone before the next one starts
    const dir = join(root, 'state-after-crash')
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    const recovered = new OrchestratorService({ ...deps, stateDir: dir }); others.push(recovered)
    await recovered.recover()
    const after = (taskId: string) => (recovered as unknown as { runs: Map<string, Run> }).runs.get(flowId)!.tasks.find(t => t.id === taskId)!
    expect(after('slow')).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringContaining(`pid ${left.pid}`) })
    expect(after('nopid').error).toContain('pid unknown')
    expect(() => recovered.retry(flowId, 'slow')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    await vi.waitFor(() => expect(after('agent')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toContain(agentId)
  })
  it('enforces recovered deadlines only once recover() says the daemon is ready, not on an early lookup', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    const a = await until('a', 'running')
    service.stop()
    const file = join(deps.stateDir, `${flowId}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.tasks[0].deadline = Date.now() - 1
    writeFileSync(file, JSON.stringify(saved))
    service = new OrchestratorService(deps)
    expect(service.roleOf(a.agentId!)).toEqual({ role: 'worker' }) // the daemon asks this while it is still starting
    // loading is synchronous: nothing was scheduled that could still arm a deadline
    expect(internals().deadlines.size).toBe(0)
    expect(state('a').state).toBe('running')
    expect(cancelled).toEqual([])
    await service.recover()
    await vi.waitFor(() => expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toEqual([a.agentId])
  })
  /** A second daemon over a copy of a running step's state, as if the first had crashed with this pid recorded. */
  const afterCrash = async (pid: number | undefined): Promise<{ recovered: OrchestratorService; step: () => Task }> => {
    await startFlow(steps({ id: 's', run: 'sleep 30', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const saved = onDisk()
    saved.tasks[0].pid = pid
    const dir = join(root, 'state-after-crash')
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    service.stop() // the original daemon is gone before the next one starts
    const recovered = new OrchestratorService({ ...deps, stateDir: dir })
    others.push(recovered)
    await recovered.recover()
    return { recovered, step: () => (recovered as unknown as { runs: Map<string, Run> }).runs.get(flowId)!.tasks[0] }
  }
  /** A second daemon on a copy of this run's saved state, started after the first one stopped (as after a crash). */
  const restartOn = async (mutate: (saved: Run) => void = () => {}): Promise<{ next: OrchestratorService; run: () => Run }> => {
    const saved = onDisk(); mutate(saved)
    service.stop()
    const dir = join(root, `state-${others.length}`)
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    const next = new OrchestratorService({ ...deps, stateDir: dir }); others.push(next)
    await next.recover()
    return { next, run: () => (next as unknown as { runs: Map<string, Run> }).runs.get(flowId)! }
  }
  const exitedPid = async (command: string, args: string[]): Promise<{ pid: number; exited: Promise<unknown> }> => {
    const child = spawn(command, args, { stdio: 'ignore' })
    leftovers.push(child.pid!)
    return { pid: child.pid!, exited: new Promise(resolve => child.once('exit', resolve)) }
  }
  /** A process the test owns, alone in its own group, standing in for a step that outlived a crashed daemon. */
  const orphan = (script = 'sleep 30'): { pid: number; exited: Promise<unknown> } => {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
    leftovers.push(-child.pid!) // afterEach kills the whole group
    return { pid: child.pid!, exited: new Promise(resolve => child.once('exit', resolve)) }
  }
  it('fails a task of a corrupt saved run instead of breaking every status read', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p' }, { id: 'b', run: 'true', depends_on: ['a'] }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const { next, run } = await restartOn(saved => { saved.tasks[1].dependsOn = ['ghost'] })
    expect(run().tasks[1]).toMatchObject({ state: 'failed', error: 'Dependency ghost is missing from this run.' })
    expect(() => next.snapshot(flowId)).not.toThrow()
  })
  it('fails a crashed step whose process already exited, and lets it be retried by hand', async () => {
    const gone = await exitedPid('true', [])
    await gone.exited
    const { recovered, step } = await afterCrash(gone.pid)
    expect(step()).toMatchObject({ state: 'failed', uncertain: false, error: `Interrupted by a daemon restart (pid ${gone.pid} had already exited). Retry to run it again.` })
    expect(step().retryAt).toBeUndefined() // never retried automatically
    expect(step()).toMatchObject({ state: 'failed', attempt: 1 })
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('refuses to retry a crashed step while its process lives, and accepts once it exited', async () => {
    const live = await exitedPid('sleep', ['30'])
    const { recovered, step } = await afterCrash(live.pid)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: expect.stringContaining(`pid ${live.pid}`) }))
    process.kill(live.pid, 'SIGKILL')
    await live.exited
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2, uncertain: false }))
  })
  it('refuses to retry a crashed step whose leader exited while its group still runs', async () => {
    const left = orphan('sleep 30 & exit 0') // the shell exits at once; its sleep stays in the group
    await left.exited
    const { recovered, step } = await afterCrash(left.pid)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringContaining(`pid ${left.pid}`) })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    process.kill(-left.pid, 'SIGKILL')
    await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
    recovered.retry(flowId, 's')
    await vi.waitFor(() => expect(step()).toMatchObject({ state: 'running', attempt: 2 }))
  })
  it('waits the doubled delay before each automatic retry, across a daemon restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', retry: { max_attempts: 3, delay: '2s' } }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    const failedAt = Date.now()
    await service.finish(flowId, 'w', 1, 'nope', [], true)
    expect(liveTask('w')).toMatchObject({ state: 'failed', retryAt: failedAt + 2000 })
    expect(onDisk().tasks[0].retryAt).toBe(failedAt + 2000)
    await vi.advanceTimersByTimeAsync(1999); expect(liveTask('w').attempt).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ attempt: 2, state: 'running' }))
    await service.finish(flowId, 'w', 2, 'nope', [], true)
    expect(liveTask('w').retryAt).toBe(Date.now() + 4000)
    const { run } = await restartOn()
    await vi.advanceTimersByTimeAsync(3999); expect(run().tasks[0].attempt).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(run().tasks[0]).toMatchObject({ attempt: 3, state: 'running' }))
  })
  it('arms one retry timer per task, however often the run moves meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', retry: { max_attempts: 2, delay: '1s' } }, { id: 'o', harness: 'test/cad', prompt: 'other' }))
    await vi.waitFor(() => { for (const id of ['w', 'o']) expect(liveTask(id).state).toBe('running') })
    await service.finish(flowId, 'w', 1, 'nope', [], true)
    const timer = internals().retryTimers.get(`${flowId}/w`)
    expect(timer).toBeDefined()
    await service.finish(flowId, 'o', 1, 'done', []) // its release pumps the run again
    expect(internals().retryTimers.get(`${flowId}/w`)).toBe(timer)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ attempt: 2, state: 'running' }))
    expect(launches).toHaveLength(3)
    expect(internals().retryTimers.size).toBe(0)
  })
  it('does not retry beside a process group that survived a crash, and keeps the retry when it is gone', async () => {
    await startFlow(steps({ id: 's', run: 'exit 1', retry: { max_attempts: 2, delay: '60s' } }))
    await vi.waitFor(() => expect(liveTask('s').retryAt).toBeDefined())
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    const left = orphan()
    const alive = await restartOn(saved => { saved.tasks[0].pid = left.pid }) // the crash hit while this group still ran
    expect(alive.run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1, error: `The daemon restarted while this step was stopping (pid ${left.pid}). Make sure it stopped before retrying.` })
    expect(alive.run().tasks[0].retryAt).toBeUndefined()
    const ended = await exitedPid('true', []); await ended.exited
    const gone = await restartOn(saved => { saved.tasks[0].pid = ended.pid })
    expect(gone.run().tasks[0]).toMatchObject({ state: 'failed', retryAt: expect.any(Number) })
  })
  it.each(['failed', 'cancelled'] as const)('refuses a manual retry of a %s step whose process group survived a crash, until it is gone', async ended => {
    await startFlow(steps({ id: 's', run: ended === 'failed' ? 'exit 1' : 'sleep 30' }))
    if (ended === 'cancelled') { await vi.waitFor(() => expect(liveTask('s').state).toBe('running')); service.cancel(flowId, 's') }
    await vi.waitFor(() => expect(liveTask('s').state).toBe(ended))
    const left = orphan()
    const { next, run } = await restartOn(saved => { saved.tasks[0].pid = left.pid }) // the crash hit while this group still ran
    expect(run().tasks[0]).toMatchObject({ state: ended === 'failed' ? 'blocked' : 'cancelled', uncertain: true, attempt: 1, error: `The daemon restarted while this step was stopping (pid ${left.pid}). Make sure it stopped before retrying.` })
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: `This step may still be running from before the daemon restart (pid ${left.pid}). Stop that process, then retry.` }))
    process.kill(-left.pid, 'SIGKILL')
    await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
    next.retry(flowId, 's')
    expect(run().tasks[0].attempt).toBe(2)
  })
  it('leaves a failed or cancelled step alone after a crash when its process is known to be gone', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'sleep 30' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('failed'))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('running'))
    service.cancel(flowId, 'b')
    const ended = await exitedPid('true', []); await ended.exited
    const { run } = await restartOn(saved => { for (const t of saved.tasks) t.pid = ended.pid })
    expect(run().tasks.map(t => [t.state, t.uncertain])).toEqual([['failed', false], ['cancelled', false]])
  })
  it('refuses to retry a crashed step whose pid was never recorded', async () => {
    const { recovered, step } = await afterCrash(undefined)
    expect(step()).toMatchObject({ state: 'blocked', uncertain: true })
    expect(() => recovered.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: expect.stringContaining('pid unknown') }))
  })
  it('recovers nothing twice and leaves deadlines of inactive projects alone', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: agent, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('agent', 'running')
    service.cancel(flowId)
    const saved = JSON.parse(readFileSync(join(deps.stateDir, `${flowId}.json`), 'utf8'))
    saved.tasks[0].state = 'running'; saved.tasks[0].deadline = Date.now() - 1 // a cancelled project is never expired
    const recovered = new OrchestratorService({ ...deps, stateDir: join(root, 'state-after-crash') })
    mkdirSync(join(root, 'state-after-crash'), { mode: 0o700 }); writeFileSync(join(root, 'state-after-crash', `${flowId}.json`), JSON.stringify(saved), { mode: 0o600 })
    await recovered.recover(); await recovered.recover()
    expect((recovered as unknown as { deadlines: Map<string, unknown> }).deadlines.size).toBe(0)
    recovered.stop()
  })
  it('enforces a deadline that came due while the project was paused once it is resumed', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    const a = await until('a', 'running')
    service.stop()
    const file = join(deps.stateDir, `${flowId}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.state = 'paused'; saved.tasks[0].deadline = Date.now() - 1
    writeFileSync(file, JSON.stringify(saved))
    service = new OrchestratorService(deps)
    await service.recover()
    expect(snap().state).toBe('paused')
    expect(internals().deadlines.size).toBe(0)
    await service.resume(flowId)
    await vi.waitFor(() => expect(state('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
    expect(cancelled).toEqual([a.agentId])
  })
  it('stops a timed-out step even when the timeout cannot be saved, and applies it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: s, run: 'sleep 30' }]\n`)
    await until('s', 'running')
    const exited = internals().steps.values().next().value!.handle.done
    const run = internals().runs.get(flowId)!
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try { await internals().expire(run, run.tasks[0], 1) } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    await exited // the process was terminated, not left to outlive its deadline
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOTDIR/) })
    expect(liveTask('s').state).toBe('running')
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 10m.' })
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']) // its process was gone: the logs go with the timeout
  }, 15_000)
  it('does not mark a worker running or arm its deadline once the daemon has stopped', async () => {
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    service.stop()
    resolve({ agentId: 'late' })
    await vi.waitFor(() => expect(state('a').agentId).toBe('late'))
    expect(state('a').state).toBe('launching')
    expect(internals().deadlines.size).toBe(0)
  })
  it('clears pending deadlines and retries when the daemon stops', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: p, timeout: 1h }]\n`)
    await until('a', 'running')
    await service.recover(); await service.resume(flowId) // an armed deadline is not armed twice
    expect(internals().deadlines.size).toBe(1)
    service.stop()
    expect(internals().deadlines.size).toBe(0)
  })
  it('skips a branch whose condition is false and completes with skipped tasks', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: check, run: 'true' }
  - { id: fix, run: 'true', depends_on: [check], trigger_rule: all_done, when: 'check.state == failed' }
  - { id: after, run: 'true', depends_on: [fix] }
  - { id: ship, run: 'true', depends_on: [check], when: 'check.state == succeeded' }
`)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(live().tasks.map(t => [t.id, t.state])).toEqual([['check', 'succeeded'], ['fix', 'skipped'], ['after', 'skipped'], ['ship', 'succeeded']])
    expect(liveTask('fix').summary).toBe('Skipped: check.state == failed is false.')
    expect(live().messages.at(-1)!.text).toBe('Flow demo completed: 2 tasks succeeded, 2 skipped.')
  })
  it('runs an all_done report after a failure, with the failed step logs already in its inputs', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: tests, run: 'echo boom >&2; exit 1' }
  - { id: report, run: 'cat inputs/tests/stderr.log', depends_on: [tests], trigger_rule: all_done }
`)
    await vi.waitFor(() => expect(live()).toMatchObject({ state: 'active', error: 'Flow stopped: tests (failed). Retry a task or cancel the project.' }))
    expect(liveTask('report')).toMatchObject({ state: 'succeeded', summary: 'boom' })
  })
  it('fails a task whose condition reads a verdict the dependency never wrote', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: review, run: 'true' }\n  - { id: gate, run: 'true', depends_on: [review], when: 'review.verdict.errors == 0' }\n`)
    await vi.waitFor(() => expect(liveTask('gate').state).toBe('failed'))
    expect(liveTask('gate')).toMatchObject({ error: 'review wrote no verdict; the condition review.verdict.errors == 0 cannot be evaluated.', cwd: '' })
  })
  it('propagates skips through tasks declared before their upstream, without a status read', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:
  - { id: d, run: 'true', depends_on: [c] }
  - { id: c, run: 'true', depends_on: [b], when: 'b.state == failed', trigger_rule: all_done }
  - { id: b, run: 'true', depends_on: [a] }
  - { id: a, run: 'true' }
`)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(live().tasks.map(t => t.state)).toEqual(['skipped', 'skipped', 'succeeded', 'succeeded'])
  })
  it('starts dependents when a result is released, without a status read', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: work }\n  - { id: b, run: 'true', depends_on: [a] }\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    await service.finish(flowId, 'a', 1, 'done', [])
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
  })
  it('never reports completed while the last attempt is still being saved', async () => {
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const states: string[] = []
    deps.changed = () => { states.push(`${live().state}:${internals().finishing.size}`) }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(states).not.toContain('completed:1')
    expect(live().state).toBe('completed')
  })
  it('publishes kept logs only to the failed attempt they belong to', async () => {
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    // Nothing public changes a failed attempt while its logs are kept (its process still holds it); the guard is defensive.
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { liveTask('bad').state = 'cancelled'; return realRename(from, to) })
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: bad, run: 'exit 4' }]\n`)
    await vi.waitFor(() => expect(liveTask('bad').state).toBe('cancelled'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('bad').artifacts).toEqual([])
  })
  it('publishes the logs of a timed-out step only to the failed attempt they belong to', async () => {
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    // The timeout takes the attempt; its logs are saved once the process is gone, and the task changes meanwhile (defensive).
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { liveTask('t').state = 'cancelled'; return realRename(from, to) })
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'cancelled', artifacts: [] })
    expect(onDisk().tasks[0].artifacts).toEqual([])
  })
  /** Fails every state write whose content matches, until the returned function is called. */
  const failWrites = (matches: (json: string) => boolean): (() => void) => {
    const actual = vi.mocked(fs.writeFileSync).getMockImplementation()!
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (typeof data === 'string' && matches(data)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return actual(file, data, options)
    })
    return () => vi.mocked(fs.writeFileSync).mockImplementation(actual)
  }
  const pausedByDisk = { state: 'paused', error: expect.stringMatching(/^Project paused after a background error: ENOSPC/) }
  it('fails an agent task that shows no real activity, heartbeats and recaps notwithstanding', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3000)
      for (const type of ['agent_activity', 'turn_heartbeat', 'turn_summary', 'error']) service.ingest({ type, agentId: 'agent-1', payload: {} })
      service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: {}, replay: true })
    }
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ state: 'failed', error: 'No activity for 10s.' }))
    expect(cancelled).toContain('agent-1')
  })
  it('counts real worker events as activity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    for (const type of ['turn_started', 'text_delta', 'thinking_delta', 'tool_start', 'tool_end', 'user_message', 'context_compact', 'subagent_finished', 'turn_ended']) {
      await vi.advanceTimersByTimeAsync(9000); service.ingest({ type, agentId: 'agent-1', payload: {} })
    }
    expect(liveTask('w').state).toBe('running')
  })
  it('does not run the idle clock inside a reconcile, and starts it again afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'w', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the barrier
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    await vi.advanceTimersByTimeAsync(11_000) // the old timer fires inside the barrier and does nothing
    expect(liveTask('w').state).toBe('running')
    hold.release(); await resumed
    await vi.advanceTimersByTimeAsync(9_999); expect(liveTask('w').state).toBe('running')
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ state: 'failed', error: 'No activity for 10s.' }))
  })
  it('stops the idle clock of a finished task and keeps the others running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }, { id: 'b', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect([liveTask('a').state, liveTask('b').state]).toEqual(['running', 'running']))
    await vi.advanceTimersByTimeAsync(5000)
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(internals().idleTimers.size).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(liveTask('b')).toMatchObject({ state: 'failed', error: 'No activity for 10s.' }))
    expect(liveTask('a').state).toBe('succeeded')
    expect(cancelled).toEqual([liveTask('b').agentId])
  })
  // An expiry waits for the attempt's owner; a newer clock armed meanwhile (activity, or a resume after a pause) decides.
  it.each([
    ['a pause before it fired', 6000, 'pause'], // paused at 6s, the old clock fires at 10s, resumed at 11s
    ['a pause while it waited', 11_000, 'pause'], // the old clock fired at 10s; paused and resumed at 11s
    ['activity while it waited', 11_000, 'activity'],
  ] as const)('drops a stale idle expiry after %s, and fails the task when the newer clock runs out', async (_, at, what) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    const expiries = vi.spyOn(service as unknown as { idle: () => Promise<void> }, 'idle')
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('w'), 1, () => new Promise<void>(resolve => { release = resolve }))
    await vi.advanceTimersByTimeAsync(at)
    if (what === 'pause') {
      internals().pause(live(), new Error('test pause'))
      await vi.advanceTimersByTimeAsync(11_000 - at)
      await service.resume(flowId) // the newer clock: 11s + 10s
    } else service.ingest({ type: 'tool_start', agentId: 'agent-1', payload: {} })
    await vi.advanceTimersByTimeAsync(1000)
    release(); await owner
    // The old clock's expiry ran (a paused run has none) and has settled: it changed nothing.
    expect(expiries).toHaveBeenCalledTimes(what === 'pause' && at < 10_000 ? 0 : 1)
    await Promise.all(expiries.mock.results.map(r => r.value))
    expect(liveTask('w').state).toBe('running')
    expect(cancelled).toEqual([])
    await vi.advanceTimersByTimeAsync(8_999)
    expect(liveTask('w').state).toBe('running')
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(liveTask('w')).toMatchObject({ state: 'failed', error: 'No activity for 10s.' }))
    expect(cancelled).toEqual(['agent-1'])
  })
  // The timeout exception does not cover idle_timeout: an idle worker is cancelled only once its failure is saved.
  it('does not cancel an idle worker whose failure cannot be saved, and cancels it on resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'w', harness: 'test/cad', prompt: 'work', idle_timeout: '10s' }))
    await vi.waitFor(() => expect(liveTask('w').state).toBe('running'))
    const recover = failWrites(json => json.includes('No activity for 10s.'))
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(cancelled).toEqual([]) // kept, not saved: nothing is touched
    recover(); await service.resume(flowId)
    expect(liveTask('w')).toMatchObject({ state: 'failed', error: 'No activity for 10s.' })
    expect(cancelled).toEqual(['agent-1'])
  })
  /** Holds the second verdict read (the first runs normally) until released. */
  const holdSecondVerdictRead = async () => {
    const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).readVerdictSnapshot
    let release!: () => void, reading = false
    vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(actual).mockImplementationOnce(async dir => {
      reading = true; await new Promise<void>(r => { release = r }); return actual(dir)
    })
    return { release: () => release(), reading: () => reading }
  }
  it('reconciles once for concurrent resumes, and launches nothing before it ends', async () => {
    await startFlow(steps(
      { id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' },
      { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
      { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' },
    ))
    await vi.waitFor(() => { expect(liveTask('a').state).toBe('running'); expect(liveTask('x').state).toBe('running') })
    live().state = 'paused' // as a background error leaves it
    liveTask('a').deadline = Date.now() - 1; liveTask('x').deadline = Date.now() - 1 // both came due while paused
    const hold = await holdSecondVerdictRead() // a expires normally, x's expiry holds the barrier
    const first = service.resume(flowId), second = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    service.snapshot(flowId) // a status read during reconcile does not pump
    expect(liveTask('b').state).toBe('queued')
    hold.release(); await Promise.all([first, second])
    expect(live().messages.filter(m => m.text.startsWith('Task x attempt 1 failed. Timed out'))).toHaveLength(1)
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
  })
  it('defers a deadline that comes due during reconcile until it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // s is listed first: the reconcile has already passed it when its deadline comes due during x's held expiry.
    await startFlow(steps({ id: 's', harness: 'test/cad', prompt: 'p', timeout: '2h' }, { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await service.recover() // the daemon is ready: deadlines are armed again at the end of a reconcile
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    await vi.advanceTimersByTimeAsync(2 * 3_600_000) // s's own timer comes due inside the barrier and does nothing
    expect(liveTask('s').state).toBe('running')
    hold.release(); await resumed
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 2h.' }))
  })
  it('stops reconciling when the project is cancelled meanwhile', async () => {
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'b', run: 'true', depends_on: ['x'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('x').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    service.cancel(flowId) // does not wait for the barrier
    hold.release(); await resumed
    expect(live().state).toBe('cancelled')
    expect(live().tasks.map(t => t.state)).toEqual(['cancelled', 'cancelled'])
    expect(internals().launching.size).toBe(0)
  })
  it('returns a launch interrupted by a pause to the queue on resume', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    let release: (() => void) | undefined, held = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      // hold the first copy of u's logs into a's inputs, once
      if (!held && String(path).includes(join('tasks', 'a', 'attempt-1', 'inputs'))) { held = true; await new Promise<void>(r => { release = r }) }
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'u', run: 'echo hello' }, { id: 'a', run: 'cat inputs/u/stdout.log', depends_on: ['u'] }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    live().state = 'paused'; release!()
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(liveTask('a').state).toBe('launching')
    await service.resume(flowId) // back to the queue, the half-prepared folder removed, launched again
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'hello', attempt: 1 }))
  })
  it('returns a launch whose preparation ends during reconcile to the queue, and launches it once the reconcile ends', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    let prepared: (() => void) | undefined, held = false
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (!held && String(path).endsWith(join('tasks', 'a', 'attempt-1'))) { held = true; await new Promise<void>(r => { prepared = r }) }
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', run: 'echo ok' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(prepared).toBeTypeOf('function') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    prepared!() // a's preparation ends while x's expiry holds the reconcile
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(liveTask('a').state).toBe('queued')
    expect(internals().steps.size).toBe(0)
    hold.release(); await resumed
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'ok', attempt: 1 }))
  })
  it('keeps the launch marker of the live preparation when a reconcile ends as an interrupted launch is queued again', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    const gates: (() => void)[] = []
    let preparations = 0
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (String(path).endsWith(join('tasks', 'a', 'attempt-1')) && ++preparations <= 2) await new Promise<void>(r => { gates.push(r) })
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', run: 'echo ok' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(gates).toHaveLength(1) })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    // The narrowest order: the reconcile ends (barrier down, one pump) the moment a is queued again, before the
    // interrupted launch has cleaned up after itself. The pump starts a replacement preparation, held in its mkdir.
    deps.changed = () => {
      if (liveTask('a').state !== 'queued' || !internals().reconciling.has(flowId)) return
      internals().reconciling.delete(flowId); internals().pump(live())
    }
    gates[0]()
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    hold.release(); await resumed // the interrupted launch has long cleaned up
    expect(internals().launching.has(`${flowId}/a`)).toBe(true) // the marker belongs to the live preparation
    await service.resume(flowId) // so another reconcile leaves that preparation alone
    gates[1]()
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'succeeded', summary: 'ok', attempt: 1 }))
    expect(preparations).toBe(2)
  })
  it('arms the deadline of a worker created during reconcile only once the reconcile ends', async () => {
    let created: (() => void) | undefined
    const create = deps.create
    deps.create = async input => {
      if (input.name === 'y') await new Promise<void>(r => { created = r })
      return create(input)
    }
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'y', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await service.recover() // the daemon is ready: deadlines are armed again at the end of a reconcile
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(created).toBeTypeOf('function') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    created!() // y's agent is created while x's expiry holds the reconcile
    await vi.waitFor(() => expect(liveTask('y').state).toBe('running'))
    expect(liveTask('y').deadline).toBeTypeOf('number')
    expect(internals().deadlines.has(`${flowId}/y/1`)).toBe(false)
    hold.release(); await resumed
    expect(internals().deadlines.has(`${flowId}/y/1`)).toBe(true)
    await service.finish(flowId, 'y', 1, 'done', [])
    expect(liveTask('y').state).toBe('succeeded')
  })
  it('refuses to resume a flow run that was cancelled or completed', async () => {
    await startFlow(steps({ id: 'a', run: 'true' }))
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    await expect(service.resume(flowId)).rejects.toMatchObject({ code: 'PROJECT_INACTIVE', message: 'This flow run has ended; start the flow again instead.' })
    expect(live().state).toBe('completed')
    live().state = 'cancelled' // the same rule for a cancelled run (a cancel step or a project cancel)
    expect(await orchestratorRequest(service, { action: 'resume', id: flowId })).toEqual({ error: 'PROJECT_INACTIVE', detail: 'This flow run has ended; start the flow again instead.' })
    expect(live().state).toBe('cancelled')
  })
  it('pauses the run again when a reconcile step fails, and then answers a request that waited for it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('x').state).toBe('running'))
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    deps.cancel = () => { throw new Error('agent unreachable') } // stopping the timed-out worker fails after the timeout was saved
    const resumed = service.resume(flowId)
    const retried = orchestratorRequest(service, { action: 'retry', id: flowId, taskId: 'x' }) // waits for the reconcile
    await expect(resumed).rejects.toThrow('agent unreachable')
    expect(await retried).toEqual({ error: 'PROJECT_INACTIVE', detail: 'Resume the project first.' })
    expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('agent unreachable') })
    expect(liveTask('x')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    await service.reconciled(flowId) // nothing is being reconciled any more
  })
  it('lets an approval answer wait for a reconcile, then finishes it', async () => {
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'ok', approval: 'Go?' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('ok').state).toBe('waiting') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the barrier
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    const answered = orchestratorRequest(service, { action: 'approve', id: flowId, taskId: 'ok', attempt: 1 })
    await vi.waitFor(() => expect(internals().reconciling.size).toBe(1))
    expect(liveTask('ok').decision).toBeUndefined() // the answer waits for the barrier
    hold.release(); await resumed
    expect(await answered).toMatchObject({ project: { id: flowId } })
    expect(liveTask('ok')).toMatchObject({ state: 'succeeded', decision: { outcome: 'approved' } })
  })
  it('stays paused when a resume cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p' }, { id: 'b', run: 'true' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    live().state = 'paused'
    diskFull()
    await expect(service.resume(flowId)).rejects.toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(live()).toMatchObject(pausedByDisk)
  })
  it('names the logs in the result of a step that failed', async () => {
    await startFlow(steps({ id: 't', run: 'echo boom >&2; exit 1' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    const result = live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!
    expect(result.text).toContain('"path":"stdout.log"')
    expect(result.text).toContain('"path":"stderr.log"')
  })
  it('pauses before anything downstream starts when the logs of a timed-out step cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1) // takes the attempt, then stops the step; its logs are kept once it is gone
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('r').state).toBe('queued')
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
  })
  it('pauses a failed launch before its release pump can start a dependent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.create = async input => {
      launches.push(input)
      // The task fails to start, and saving that failure fails once.
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
      throw new OrchestratorError('HARNESS_UNAVAILABLE', 'gone')
    }
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: p }\n  - { id: b, harness: test/cad, prompt: p, depends_on: [a], trigger_rule: all_done }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().launching.size).toBe(0)) // its release pump has run
    expect(launches).toHaveLength(1)
    expect(liveTask('b').state).toBe('queued')
  })
  it('pauses when a skip cannot be saved after a step process is gone, and skips on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('"state":"skipped"'))
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: check, run: 'true' }\n  - { id: fix, run: 'true', depends_on: [check], when: 'check.state == failed' }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(live().tasks.map(t => t.state)).toEqual(['succeeded', 'queued'])
    recover(); await service.resume(flowId)
    expect(live()).toMatchObject({ state: 'completed' })
    expect(liveTask('fix').state).toBe('skipped')
  })
  it('pauses when a block cannot be saved, and blocks on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('An upstream task did not succeed.'))
    await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: bad, run: 'exit 4' }\n  - { id: after, run: 'true', depends_on: [bad] }\n`)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(live().tasks.map(t => t.state)).toEqual(['failed', 'queued'])
    recover(); await service.resume(flowId)
    expect(liveTask('after').state).toBe('blocked')
    expect(live()).toMatchObject({ state: 'active', error: 'Flow stopped: bad (failed), after (blocked). Retry a task or cancel the project.' })
  })
  it('pauses when the completion cannot be saved after the last result, and completes on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"completed"'))
    await service.finish(flowId, 'a', 1, 'done', []) // the result itself was saved: no error for its reporter
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    recover(); await service.resume(flowId)
    expect(live()).toMatchObject({ state: 'completed', error: null })
    expect(live().messages.at(-1)!.text).toBe('Flow demo completed: 1 tasks succeeded.')
  })
  it('keeps a taken result when the release pump cannot save and the pause notification fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: observer down')
  })
  it('still stops a timed-out worker when the release pump cannot save and the pause notification fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work, timeout: 1h }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    const agentId = liveTask('a').agentId
    failWrites(json => json.includes('Flow stopped:'))
    deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
    await internals().expire(live(), liveTask('a'), 1)
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(cancelled).toEqual([agentId])
    expect(live()).toMatchObject(pausedByDisk)
  })
  it('keeps the run paused when the pause notification throws a value that is not an Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw undefined }
    await service.finish(flowId, 'a', 1, 'done', [])
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: undefined')
  })
  it('keeps the run paused when the pause notification throws a value that cannot be turned into text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(`spec: 1\nname: demo\ntasks: [{ id: a, harness: test/cad, prompt: work }]\n`)
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    failWrites(json => json.includes('"state":"completed"'))
    deps.changed = () => { if (live().state === 'paused') throw Object.create(null) }
    await expect(service.finish(flowId, 'a', 1, 'done', [])).resolves.toBeUndefined()
    expect(liveTask('a').state).toBe('succeeded')
    expect(live()).toMatchObject(pausedByDisk)
    expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: unknown error')
  })
  it('pauses a failed launch without an unhandled rejection when the pause notification throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      deps.create = async input => {
        launches.push(input)
        vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
        throw new OrchestratorError('HARNESS_UNAVAILABLE', 'gone')
      }
      deps.changed = () => { if (live().state === 'paused') throw new Error('observer down') }
      await startFlow(`spec: 1\nname: demo\ntasks:\n  - { id: a, harness: test/cad, prompt: p }\n  - { id: b, harness: test/cad, prompt: p, depends_on: [a], trigger_rule: all_done }\n`)
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      await vi.waitFor(() => expect(internals().launching.size).toBe(0)) // its release pump has run
      expect(unhandled).not.toHaveBeenCalled()
      expect(launches).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith('[orchestrator] pause notification failed: observer down')
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('re-evaluates skipped downstream tasks when an upstream task is retried', async () => {
    await startFlow(steps({ id: 'a', run: 'test -f "$HARNESS_PROJECT_DIR/ok"' }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done', when: 'a.state == succeeded' }))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('skipped'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    writeFileSync(join(project, 'ok'), '')
    service.retry(flowId, 'a')
    expect(onDisk().tasks.find(t => t.id === 'b')).toMatchObject({ state: 'queued', attempt: 1, summary: '' }) // in the same save as a's new attempt
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('b')).toMatchObject({ state: 'succeeded', attempt: 1 })
  })
  it('starts every new attempt from the reset table, also an automatic retry', async () => {
    await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'p', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    mkdirSync(join(liveTask('a').cwd, '.harness'))
    writeFileSync(join(liveTask('a').cwd, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, findings: [{ severity: 'error' }] }))
    const verdicts: unknown[] = []
    deps.changed = () => { verdicts.push(structuredClone(liveTask('a').verdict)) } // the failed attempt's verdict is saved first
    await service.finish(flowId, 'a', 1, 'broken', [], true)
    await vi.waitFor(() => expect(liveTask('a')).toMatchObject({ state: 'running', attempt: 2 }))
    expect(verdicts).toContainEqual({ ready: false, errors: 1, warnings: 0 })
    expect(liveTask('a')).toMatchObject({ summary: '', error: null, artifacts: [] })
    expect(liveTask('a').verdict).toBeUndefined()
    expect(live().messages.filter(m => m.text === 'Task a attempt 1 failed; retrying (attempt 2 of 2).')).toHaveLength(1)
  })
  it('changes nothing when a manual retry cannot be saved', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }))
    await vi.waitFor(() => expect(live().error).toMatch(/^Flow stopped/))
    const before = JSON.stringify(live())
    diskFull()
    expect(() => service.retry(flowId, 'a')).toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(JSON.stringify(live())).toBe(before)
  })
  it('pauses and keeps the retry due when an automatic retry cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.includes('retrying (attempt 2 of 2)'))
    await startFlow(steps({ id: 'a', run: '[ "$HARNESS_ATTEMPT" = 1 ] && exit 1; true', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('a')).toMatchObject({ state: 'failed', attempt: 1 })
    recover(); await service.resume(flowId)
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('a').attempt).toBe(2)
    expect(live().messages.filter(m => m.text.startsWith('Task a attempt 1 failed; retrying'))).toHaveLength(1)
  })
  it('keeps a step result that arrives while the project is paused and applies it on resume', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    expect(liveTask('s').state).toBe('running')
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(live().state).toBe('completed')
  })
  it('keeps the logs of a step that failed while paused, before anything downstream starts', async () => {
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; echo boom >&2; exit 1` }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    expect(liveTask('r').summary).toBe('boom')
  })
  it('pauses with the result kept when an automatic result cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"succeeded"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(live().state).toBe('completed')
  })
  it('keeps an automatic result when the run is paused while it is being saved', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const hold = holdVerdictRead()
    g.open()
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    live().state = 'paused'
    hold.release()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('lets a result seen before the deadline win over it, and the deadline win over a later one', async () => {
    const early = gate('early'), late = gate('late')
    await startFlow(steps({ id: 'early', run: early.run, timeout: '1h' }, { id: 'late', run: late.run, timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('early').state).toBe('running'); expect(liveTask('late').state).toBe('running') })
    live().state = 'paused'
    early.open(); late.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(2))
    const seen = (id: string) => [...internals().pending.values()].find(p => p.task.id === id)!.at
    liveTask('early').deadline = seen('early') + 1 // still ahead when its result was seen
    liveTask('late').deadline = seen('late') // reached when its result was seen
    await service.resume(flowId)
    expect(liveTask('early').state).toBe('succeeded')
    expect(liveTask('late')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(liveTask('late').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log']) // its process was gone: the logs go with the timeout
  })
  it('stops a step whose pid cannot be saved, owns it until it is gone, and fails it on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 's')?.state === 'running')
    await startFlow(steps({ id: 's', run: 'sleep 30' }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('launching')
    await vi.waitFor(() => expect(internals().steps.size).toBe(0)) // stopped, and owned until its group was gone
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Stopped: its process id could not be saved \(ENOSPC/) })
  })
  it('fails a shell step whose result was pending when the daemon stops, and saves that', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    service.stop()
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('keeps the logs of a timed-out step on resume when saving them paused the run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'cat inputs/t/stdout.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    recover(); await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('defers a result seen during a reconcile, and lets its deadline win when it was seen after it', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: g.run, timeout: '1h' }, { id: 'b', run: 'true', depends_on: ['s'] }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the barrier
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    liveTask('s').deadline = Date.now() - 1 // s's deadline passed before its exit is seen
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // kept, not settled inside the barrier
    expect(liveTask('s').state).toBe('running')
    hold.release(); await resumed
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(liveTask('b').state).toBe('blocked')
  })
  it('stops nothing for a timeout deferred behind a reconcile until it is saved', async () => {
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'a', harness: 'test/cad', prompt: 'p', timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('a').state).toBe('running') })
    const aAgent = liveTask('a').agentId!
    let releaseOwner!: () => void
    const owner = internals().exclusive(live(), liveTask('a'), 1, () => new Promise<void>(r => { releaseOwner = r }))
    const expiring = internals().expire(live(), liveTask('a'), 1) // waits for a's owner
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the reconcile
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    releaseOwner(); await owner; await expiring // a's expiry resumes inside the barrier: deferred, no storage failure
    expect(internals().pending.size).toBe(1)
    expect(cancelled).not.toContain(aAgent)
    hold.release(); await resumed
    expect(liveTask('a')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    expect(cancelled).toContain(aAgent) // only once the replayed timeout was saved
  })
  it('lets a result seen before its deadline win when the deadline passes while the reconcile still runs', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: g.run, timeout: '1h' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
    const hold = holdVerdictRead() // x's expiry holds the reconcile in step 4, before it reaches s
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // s's exit, kept
    const seen = [...internals().pending.values()][0].at
    liveTask('s').deadline = seen + 1 // still ahead when the exit was seen
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(seen + 1)) // and passed before step 4 reaches s
    hold.release(); await resumed
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('pauses when a failed step\'s logs cannot be copied, keeps them on resume, and starts nothing downstream before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; echo boom >&2; exit 1` }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.copyFile).mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('t').state).toBe('running')
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
  })
  it('repairs the logs of a timed-out step on resume when their rename failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('writes nothing more for a log repair once the project is cancelled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks[0].artifacts.length) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    recover()
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    let release: (() => void) | undefined
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await new Promise<void>(r => { release = r }); return realCopy(from, to) })
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function')) // the repair is copying t's logs
    service.cancel(flowId)
    release!(); await resumed
    expect(liveTask('t').artifacts).toEqual([]) // the folder the first, failed save renamed stays unreferenced
    expect(onDisk().tasks[0].artifacts).toEqual([])
    expect(readdirSync(join(live().root, 'artifacts')).filter(n => n.endsWith('.staging'))).toEqual([]) // the held copy wrote nothing that stays
  })
  it('stays paused with the result still kept when it cannot be saved on resume either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.includes('"state":"succeeded"'))
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await service.resume(flowId) // the resume itself is saved; applying the kept result fails again
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
  })
  it('stays paused when the logs of a failed step cannot be saved on resume', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    await expect(service.resume(flowId)).rejects.toThrow(/ENOSPC/)
    expect(live()).toMatchObject(pausedByDisk)
    expect(liveTask('t').artifacts).toEqual([])
    expect(liveTask('r').state).toBe('queued')
    recover(); await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stdout.log', 'stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('fails a step that removed its own logs without keeping any', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: 'rm -f stdout.log stderr.log; exit 3' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('failed'))
    expect(liveTask('s')).toMatchObject({ error: 'exit 3', artifacts: [] })
    expect(warn).toHaveBeenCalledWith('[orchestrator] s attempt 1: logs not kept: stdout.log (missing); stderr.log (missing)')
  })
  it('fails a step whose log is not a regular file, keeping the other log and naming the one left out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 's', run: 'rm stdout.log && mkdir stdout.log; echo boom >&2; exit 1' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('failed'))
    expect(liveTask('s')).toMatchObject({ error: 'exit 1: boom' })
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task s attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log must be a regular file of at most 256 MiB.)')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[orchestrator] s attempt 1: logs not kept: stdout.log'))
    expect(live().state).toBe('active')
  })
  it('fails a step whose log changes while it is copied, keeping the other log', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); appendFileSync(String(from), 'late') })
    g.open()
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t')).toMatchObject({ error: 'exit 1' })
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log changed during handoff')
    expect(live().state).toBe('active')
  })
  it('applies a timeout whose logs cannot be kept, without them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('s')
    await startFlow(steps({ id: 's', run: `rm stdout.log stderr.log && mkdir stdout.log stderr.log; ${g.run}`, timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    liveTask('s').deadline = [...internals().pending.values()][0].at // the exit was seen at the deadline: the timeout wins
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
    expect(live().messages.find(m => m.text.startsWith('Task s attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (stdout.log must be a regular file')
  })
  it('leaves logs that cannot be kept out after a timeout, also on resume, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'rm stdout.log stderr.log && mkdir stdout.log stderr.log; sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    await vi.waitFor(() => expect(statSync(join(liveTask('t').cwd, 'stderr.log')).isDirectory()).toBe(true))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.', artifacts: [] })
    expect(live().state).toBe('active')
    live().state = 'paused'
    await service.resume(flowId) // the repair leaves them alone instead of pausing again
    expect(live().state).toBe('active')
    expect(liveTask('t').artifacts).toEqual([])
  })
  it('keeps only the logs a successful step left', async () => {
    await startFlow(steps({ id: 's', run: 'rm stdout.log; echo done >&2' }))
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
  })
  it('fails a step whose pid could not be saved even when it exits cleanly once stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const recover = failWrites(json => {
      if (!json.startsWith('{"version"') || (JSON.parse(json) as Run).tasks.find(t => t.id === 's')?.state !== 'running') return false
      // The failed pid save stops the step at once: hold it until the step has installed its trap, so it exits 0.
      const trapped = join(liveTask('s').cwd, 'trapped'), giveUp = Date.now() + 5000
      while (!existsSync(trapped) && Date.now() < giveUp) { /* the step runs in its own process */ }
      return true
    })
    await startFlow(steps({ id: 's', run: "trap 'exit 0' TERM; : > trapped; while :; do sleep 0.05; done" }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Stopped: its process id could not be saved \(ENOSPC/) })
  })
  it('repairs the stderr log of a timed-out step on resume when its stdout log is gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'rm stdout.log; sleep 30', timeout: '1h' }, { id: 'r', run: 'cat inputs/t/stderr.log', depends_on: ['t'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    await vi.waitFor(() => expect(existsSync(join(liveTask('t').cwd, 'stdout.log'))).toBe(false))
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live().state).toBe('paused'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('r').state).toBe('queued')
    await service.resume(flowId)
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    await vi.waitFor(() => expect(liveTask('r').state).toBe('succeeded'))
  })
  it('fails a shell step on a daemon stop while its kept result is being applied', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    const hold = holdVerdictRead()
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true)) // the kept exit is being applied
    service.stop()
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
    hold.release(); await resumed
    expect(onDisk().tasks[0]).toMatchObject({ state: 'failed', error: 'Stopped with the daemon.' })
  })
  it('fails a step whose log vanishes while it is copied, keeping the other log, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { await realCopy(from, to); unlinkSync(String(from)) })
    g.open()
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (missing)')
    expect(live().state).toBe('active')
  })
  it('does not try again on resume to keep logs that changed during every copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const realCopy = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).copyFile
    vi.mocked(filesystem.copyFile).mockImplementation(async (from, to) => { await realCopy(from, to); appendFileSync(String(from), 'late') })
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    expect(liveTask('t')).toMatchObject({ state: 'failed', artifacts: [] })
    const copies = vi.mocked(filesystem.copyFile).mock.calls.length
    live().state = 'paused'
    await service.resume(flowId)
    expect(vi.mocked(filesystem.copyFile).mock.calls.length).toBe(copies) // remembered as not kept
    expect(live().state).toBe('active')
    vi.mocked(filesystem.copyFile).mockImplementation(realCopy)
  })
  it('keeps the logs a deferred step success has when it is applied, not those it had at exit', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    unlinkSync(join(liveTask('s').cwd, 'stdout.log'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().state).toBe('completed')
  })
  it('applies a deferred step success whose log became a folder, without that log', async () => {
    const g = gate('s')
    await startFlow(steps({ id: 's', run: g.run }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    g.open()
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    const log = join(liveTask('s').cwd, 'stderr.log')
    unlinkSync(log); mkdirSync(log)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await service.resume(flowId)
    expect(liveTask('s').state).toBe('succeeded')
    expect(liveTask('s').artifacts.map(a => a.path)).toEqual(['stdout.log'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('logs not kept: stderr.log (stderr.log must be a regular file'))
    expect(live().state).toBe('completed')
  })
  it.skipIf(process.getuid?.() === 0)('fails a step whose log cannot be read, keeping the other log, without pausing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'chmod 000 stdout.log; exit 1' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('failed'))
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
    expect(live().messages.find(m => m.text.startsWith('Task t attempt 1 failed.'))!.text).toContain('Logs not kept: stdout.log (EACCES')
    expect(live().state).toBe('active')
  })
  it('pauses with the result kept when a log copy cannot be stored, even when its source is removed meanwhile', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = gate('t')
    await startFlow(steps({ id: 't', run: `${g.run}; exit 1` }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => {
      unlinkSync(String(from))
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC', syscall: 'copyfile', path: String(from), dest: String(to) })
    })
    g.open()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('t').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    await service.resume(flowId) // the copy is tried again: its source is gone now, so that log is not kept
    expect(liveTask('t')).toMatchObject({ state: 'failed', error: 'exit 1' })
    expect(liveTask('t').artifacts.map(a => a.path)).toEqual(['stderr.log'])
  })
  /** Fake step processes, pid 999_999, a fresh one per spawn: the leader is gone, the group answers until `gone()`. */
  const lingeringStep = () => {
    const make = () => Object.assign(new EventEmitter(), { pid: 999_999, stdout: new PassThrough(), stderr: new PassThrough() })
    let fake = make()
    const spawned = vi.fn(() => { fake = make(); return fake as unknown as ChildProcess })
    deps.spawnStep = spawned
    let groupAlive = true
    const real = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      if (Math.abs(target) !== 999_999) return real(target, signal as never)
      if (signal === 0 && (target > 0 || !groupAlive)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true // the group still answers; signals to it are swallowed
    }) as typeof process.kill)
    return {
      spawned, gone: () => { groupAlive = false }, alive: () => { groupAlive = true },
      /** The latest process exits with code 1; the grace period and the time allowed to confirm its group pass. */
      end: async () => { fake.emit('exit', 1, null); fake.emit('close'); await vi.advanceTimersByTimeAsync(10_000) },
    }
  }
  it('blocks a step as uncertain when its leftovers could not be confirmed stopped, and keeps owning it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 3 } }, { id: 'after', run: 'true', depends_on: ['s'] }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, error: expect.stringMatching(/could not be confirmed stopped/) }))
    expect(liveTask('s').retryAt).toBeUndefined()
    expect(internals().steps.size).toBe(1) // still signalled by cancel and stop
    await vi.waitFor(() => expect(liveTask('after').state).toBe('blocked'))
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    service.retry(flowId, 's')
    expect(internals().steps.size).toBe(0)
    expect(liveTask('s').attempt).toBe(2)
  })
  it('keeps an attempt that timed out and is due for retry from being replaced while its group may still run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', timeout: '1h', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await internals().expire(live(), liveTask('s'), 1) // saved: failed, retry due
    expect(liveTask('s')).toMatchObject({ state: 'failed', retryAt: expect.any(Number) })
    await step.end() // the stop could not be confirmed
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 }))
    expect(liveTask('s').retryAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(step.spawned).toHaveBeenCalledTimes(1) // never replaced
  })
  it('keeps an uncertainty that cannot be saved, and applies it on resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].uncertain === true)
    await step.end()
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    expect(liveTask('s').state).toBe('running')
    expect(internals().pending.size).toBe(1)
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 })
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('keeps an uncertainty seen while the run pauses during the wait for the attempt owner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('s'), 1, () => new Promise<void>(r => { release = r }))
    await step.end()
    live().state = 'paused' // while the uncertainty waits for the owner
    release(); await owner
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true })
  })
  it('keeps an uncertainty seen after the deadline over the timeout, and starts nothing after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 's', run: 'x', timeout: '1h' }, { id: 'r', run: 'true', depends_on: ['s'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
    live().state = 'paused'
    liveTask('x').deadline = Date.now() - 1; liveTask('s').deadline = Date.now() - 1 // both overdue; x comes first in step 4
    const hold = holdVerdictRead() // x's expiry holds step 4 before it reaches s
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(hold.reading()).toBe(true))
    await step.end() // s ends after its deadline, its group unconfirmed: the uncertainty is kept (the barrier is up)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    hold.release(); await resumed
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true })
    expect(liveTask('s').retryAt).toBeUndefined()
    expect(liveTask('r').state).toBe('queued') // all_done waits for an uncertain upstream
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('fences a step whose pid could not be saved and whose group could not be confirmed stopped, and refuses its retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const step = lingeringStep()
    const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].state === 'running')
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await step.end() // stopped by the daemon, its group unconfirmed: the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    recover(); await service.resume(flowId)
    expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 })
    expect(liveTask('s').pid).toBeUndefined()
    step.gone()
    expect(() => service.retry(flowId, 's')).toThrow('This step may still be running (pid unknown). Stop that process, then retry.')
    expect(step.spawned).toHaveBeenCalledTimes(1)
  })
  it('keeps the first uncertainty of an attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true }))
    const { error, revision } = { error: liveTask('s').error, revision: live().revision }
    expect(await internals().fenceUncertain(live(), liveTask('s'), 1, 'Another uncertainty.', 'check', Date.now())).toBe(false)
    expect(liveTask('s').error).toBe(error)
    expect(live().revision).toBe(revision)
  })
  it.each(['running', 'cancelled'] as const)('saves an uncertainty kept at a daemon stop, so the next daemon waits for the group (%s)', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', retry: { max_attempts: 2 } }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    live().state = 'paused'
    await step.end() // the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    if (kind === 'cancelled') service.cancel(flowId, 's')
    service.stop() // a graceful stop, saved before the next daemon reads the state
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: kind === 'running' ? 'blocked' : 'cancelled', uncertain: true, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('marks a cancelled step uncertain when its stop could not be confirmed, so a retry after a restart waits for the group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    service.cancel(flowId, 's')
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'cancelled', uncertain: true }))
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    service.stop()
    const { next, run } = await restartOn()
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('keeps a lingering step owned when its retry is refused for another reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }, { id: 'after', run: 'true', depends_on: ['s'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await step.end()
    await vi.waitFor(() => expect(liveTask('s')).toMatchObject({ state: 'blocked', uncertain: true }))
    liveTask('after').state = 'running' // downstream work still uses this attempt
    step.gone()
    expect(() => service.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE' }))
    expect(internals().steps.size).toBe(1)
  })
  it('saves an uncertainty kept for an attempt that already failed on its last timeout, so the next daemon waits for the group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    await internals().expire(live(), liveTask('s'), 1) // saved: failed, no retry left
    expect(liveTask('s')).toMatchObject({ state: 'failed', uncertain: false })
    live().state = 'paused'
    await step.end() // the stop could not be confirmed: the uncertainty is kept (the run is paused)
    await vi.waitFor(() => expect(internals().pending.size).toBe(1))
    service.stop() // a graceful stop, saved before the next daemon reads the state
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, pid: 999_999, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })
  it('saves an uncertainty seen while the fence waits for the attempt owner when the daemon stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const step = lingeringStep()
    await startFlow(steps({ id: 's', run: 'x' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('running'))
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('s'), 1, () => new Promise<void>(r => { release = r }))
    await step.end()
    await vi.waitFor(() => expect([...internals().steps.values()][0].uncertain).toMatch(/could not be confirmed stopped/))
    expect(internals().pending.size).toBe(0) // the fence still waits for the owner
    service.stop()
    release(); await owner
    const { next, run } = await restartOn()
    expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, pid: 999_999, error: expect.stringMatching(/could not be confirmed stopped/) })
    await next.resume(flowId)
    expect(() => next.retry(flowId, 's')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
    step.gone()
    next.retry(flowId, 's')
    expect(run().tasks[0]).toMatchObject({ attempt: 2, uncertain: false })
  })

  it('retries an upstream task by re-running everything that already used it', async () => {
    await startFlow(steps(
      { id: 'tests', run: 'test -f "$HARNESS_PROJECT_DIR/ok"' },
      { id: 'report', run: 'echo report', depends_on: ['tests'], trigger_rule: 'all_done' },
      { id: 'deploy', run: 'true', depends_on: ['tests'] },
    ))
    await vi.waitFor(() => expect(live().error).toMatch(/^Flow stopped/))
    const oldReport = liveTask('report').cwd
    writeFileSync(join(project, 'ok'), '')
    service.retry(flowId, 'tests')
    await vi.waitFor(() => expect(live().state).toBe('completed'))
    expect(live().tasks.map(t => [t.id, t.attempt])).toEqual([['tests', 2], ['report', 2], ['deploy', 1]]) // deploy never started
    expect(existsSync(join(oldReport, 'stdout.log'))).toBe(true) // old attempts stay on disk
  })
  it('refuses a cascade while something downstream still uses the result, or while it still stops', async () => {
    const g = gate('b')
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: g.run, depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('running'))
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'b still uses this result; cancel b first.' }))
    service.cancel(flowId, 'b')
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE' })) // b's process is still stopping
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    service.retry(flowId, 'a')
    expect(liveTask('b')).toMatchObject({ state: 'queued', attempt: 2 })
  })
  it('refuses a cascade while the target\'s logs are still being kept', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await startFlow(steps({ id: 't', run: 'sleep 30', timeout: '1h' }))
    await vi.waitFor(() => expect(liveTask('t').state).toBe('running'))
    const recover = failWrites(json => json.startsWith('{"version"') && ((JSON.parse(json) as Run).tasks.find(t => t.id === 't')?.artifacts.length ?? 0) > 0)
    await internals().expire(live(), liveTask('t'), 1)
    await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    recover()
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    let release: (() => void) | undefined
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { await new Promise<void>(r => { release = r }); return realRename(from, to) })
    const resumed = service.resume(flowId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function')) // reconcile is keeping t's logs, inside t's owner
    expect(() => service.retry(flowId, 't')).toThrow(expect.objectContaining({ code: 'TASK_STOPPING' }))
    release!(); await resumed
    service.retry(flowId, 't')
    expect(liveTask('t').attempt).toBe(2)
  })
  it('refuses a cascade over an uncertain downstream task', async () => {
    let calls = 0
    deps.create = async input => { launches.push(input); if (++calls === 1) throw new OrchestratorError('SPAWN_FAILED', 'pane lost'); return { agentId: 'agent-x' } }
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', harness: 'test/cad', prompt: 'p', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('b')).toMatchObject({ state: 'blocked', uncertain: true }))
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'b still uses this result; cancel b first.' }))
  })
  it('changes nothing when a cascade cannot be saved, and clears the retry timer it replaces', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1', retry: { max_attempts: 2, delay: '60s' } }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(internals().retryTimers.size).toBe(1))
    const before = JSON.stringify(live())
    const timers = { deadlines: internals().deadlines.size }
    diskFull()
    expect(() => service.retry(flowId, 'a')).toThrow(/ENOSPC/)
    vi.mocked(fs.writeFileSync).mockReset()
    expect(JSON.stringify(live())).toBe(before)
    expect(internals().retryTimers.size).toBe(1)
    expect(internals().deadlines.size).toBe(timers.deadlines)
    service.retry(flowId, 'a')
    expect(internals().retryTimers.size).toBe(0)
  })
  it('refuses a cascade while a dependent is still launching', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
    let release: (() => void) | undefined
    vi.mocked(filesystem.mkdir).mockImplementation(async (path, options) => {
      if (!release && String(path).endsWith(join('tasks', 'b', 'attempt-1'))) await new Promise<void>(r => { release = r })
      return realMkdir(path, options)
    })
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'b still uses this result; cancel b first.' }))
    release!()
  })
  it('refuses a cascade while a finished dependent is still owned by an operation on its attempt', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    let release!: () => void
    const owner = internals().exclusive(live(), liveTask('b'), 1, () => new Promise<void>(r => { release = r })) // b is terminal, its attempt still owned
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'b still uses this result; cancel b first.' }))
    release(); await owner
    service.retry(flowId, 'a')
    expect(liveTask('b')).toMatchObject({ state: 'queued', attempt: 2 })
  })
  it('refuses a cascade while a dependent result is kept for a resume', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'true', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('b').state).toBe('succeeded'))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    // a kept result is only reachable while paused or reconciling; the owner rule is what this pins
    internals().pending.set(`${flowId}/b/1`, { task: liveTask('b'), at: Date.now(), source: 'exit' } as never)
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE' }))
    internals().pending.clear()
  })
  it('saves a cascade once, with the full reset table, before any launch', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'echo b', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(live().error).toMatch(/^Flow stopped/))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    // every field of the reset table set on the started dependent (fields one task kind cannot hold together are set directly)
    Object.assign(liveTask('b'), {
      state: 'failed', error: 'e', uncertain: false, agentId: 'agent-x', summary: 's', deadline: 1, pid: 999_999, engine: 'claude',
      verdict: { ready: true, errors: 0, warnings: 0 }, decision: { outcome: 'approved', at: 1 }, loopState: { phase: 'working', completed: 1, turn: 1 },
      retryAt: Date.now() + 60_000, scripts: [{ path: '/x', sha256: 'y' }],
    })
    const realWrite = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync
    const saved: Run[] = []
    vi.mocked(fs.writeFileSync).mockImplementation(((file: string, data: string, options: unknown) => {
      if (typeof data === 'string' && data.startsWith('{"version"')) saved.push(JSON.parse(data) as Run)
      return realWrite(file, data, options as never)
    }) as typeof fs.writeFileSync)
    service.retry(flowId, 'a')
    const resets = saved.filter(r => r.tasks.every(t => t.state === 'queued' && t.attempt === 2))
    expect(resets).toHaveLength(1) // exactly one save resets both
    expect(saved.indexOf(resets[0])).toBe(0) // before every launch
    expect(saved.slice(1).every(r => r.tasks.some(t => t.state !== 'queued'))).toBe(true) // the later saves are launches
    expect(saved.filter(r => r.tasks.find(t => t.id === 'a')!.attempt === 2 && r.tasks.find(t => t.id === 'b')!.attempt === 1)).toEqual([]) // never half a cascade
    for (const t of saved[0].tasks) {
      expect(t).toMatchObject({ error: null, uncertain: false, agentId: null, cwd: '', artifacts: [], inputs: {}, summary: '' })
      for (const key of ['deadline', 'pid', 'engine', 'verdict', 'decision', 'loopState', 'retryAt', 'scripts']) expect(t).not.toHaveProperty(key)
    }
  })
  it('clears every timer of the tasks a cascade resets', async () => {
    await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'b', run: 'echo b', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(live().error).toMatch(/^Flow stopped/))
    await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    // no reset task holds a deadline timer by now; the reset table still drops one of any attempt
    const timer = setTimeout(() => {}, 60_000)
    internals().deadlines.set(`${flowId}/b/1`, timer)
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    service.retry(flowId, 'a')
    expect(cleared).toHaveBeenCalledWith(timer)
    expect([...internals().deadlines.keys()].filter(key => key.startsWith(`${flowId}/b/`))).toEqual([])
  })
  it('refuses a cascade over a dependent whose stop could not be confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const b = lingeringStep() // every step of this flow is the fake process; a is made to fail through it too
    await startFlow(steps({ id: 'a', run: 'x' }, { id: 'b', run: 'x', depends_on: ['a'], trigger_rule: 'all_done' }))
    await vi.waitFor(() => expect(liveTask('a').state).toBe('running'))
    b.gone(); await b.end() // a fails, its group gone
    await vi.waitFor(() => expect(liveTask('b').state).toBe('running'))
    b.alive(); await b.end() // b ends, its group still answers
    await vi.waitFor(() => expect(liveTask('b')).toMatchObject({ state: 'blocked', uncertain: true }))
    expect(internals().steps.size).toBe(1) // b's lingering owner
    expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'b still uses this result; cancel b first.' }))
  })

  describe('approvals', () => {
    const approvalFlow = (extra: Record<string, unknown> = {}) => steps(
      { id: 'build', run: 'echo built' },
      { id: 'ok', approval: { message: 'Ship it?', decisions: [{ id: 'ship' }, { id: 'rework' }] }, depends_on: ['build'], ...extra },
      { id: 'ship', run: 'cat inputs/ok/approval.json', depends_on: ['ok'], when: 'ok.decision == ship' },
    )
    const waiting = async () => { await vi.waitFor(() => expect(liveTask('ok').state).toBe('waiting')) }
    const okSucceeded = (json: string) => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 'ok')?.state === 'succeeded'
    it('waits for a decision, records it as an artifact, and branches on it', async () => {
      await startFlow(approvalFlow()); await waiting()
      expect(live().messages.at(-1)!.text).toBe('Task ok is waiting for approval: Ship it? Decisions: ship, rework.')
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved' })).rejects.toMatchObject({ code: 'INVALID_DECISION' })
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'rejected', decision: 'ship' })).rejects.toMatchObject({ code: 'INVALID_DECISION' })
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship', comment: ' looks good ' })
      await vi.waitFor(() => expect(live().state).toBe('completed'))
      expect(liveTask('ok')).toMatchObject({ state: 'succeeded', summary: 'Approved: ship (looks good)', decision: { outcome: 'approved', decision: 'ship', comment: 'looks good' }, artifacts: [{ path: 'approval.json' }] })
      expect(JSON.parse(liveTask('ship').summary)).toMatchObject({ attempt: 1, outcome: 'approved', decision: 'ship', label: 'ship', comment: 'looks good' })
      expect(live().messages.some(m => m.role === 'user' && m.text === 'ok: looks good')).toBe(true)
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship', comment: 'looks good' }) // the same answer again: nothing happens
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'DECISION_CONFLICT' })
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship', comment: 'other' })).rejects.toMatchObject({ code: 'DECISION_CONFLICT' })
    })
    it('takes the same answer sent twice at once only once', async () => {
      await startFlow(approvalFlow()); await waiting()
      await Promise.all([service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' }), service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })])
      expect(readdirSync(join(live().root, 'artifacts', 'ok'))).toEqual(['attempt-1'])
      expect(live().messages.filter(m => m.text.startsWith('Task ok attempt 1 succeeded'))).toHaveLength(1)
    })
    it('refuses the second of two different answers sent at once', async () => {
      await startFlow(approvalFlow()); await waiting()
      const results = await Promise.allSettled([service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' }), service.answer(flowId, 'ok', 1, { outcome: 'rejected' })])
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'DECISION_CONFLICT' })
    })
    it('fails the task on reject, never retries it by itself, and asks again on a manual retry', async () => {
      await startFlow(approvalFlow()); await waiting()
      await service.answer(flowId, 'ok', 1, { outcome: 'rejected', comment: 'not yet' })
      expect(liveTask('ok')).toMatchObject({ state: 'failed', error: 'Rejected: not yet' })
      expect(liveTask('ok').retryAt).toBeUndefined()
      await expect(service.answer(flowId, 'ok', 2, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'STALE_ATTEMPT' })
      service.retry(flowId, 'ok')
      await vi.waitFor(() => expect(liveTask('ok')).toMatchObject({ state: 'waiting', attempt: 2 }))
      expect(liveTask('ok').decision).toBeUndefined()
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toMatchObject({ code: 'STALE_ATTEMPT' })
    })
    it('changes nothing when the decision itself cannot be saved', async () => {
      await startFlow(approvalFlow()); await waiting()
      diskFull()
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow(/ENOSPC/)
      vi.mocked(fs.writeFileSync).mockReset()
      expect(liveTask('ok').decision).toBeUndefined()
      await service.answer(flowId, 'ok', 1, { outcome: 'rejected' }) // still open: any answer may come
      expect(liveTask('ok').state).toBe('failed')
    })
    it('keeps the decision when its record cannot be stored, and finishes it when the same answer comes again', async () => {
      await startFlow(approvalFlow()); await waiting()
      vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('disk full'))
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow('disk full')
      expect(liveTask('ok')).toMatchObject({ state: 'waiting', decision: { decision: 'ship' } })
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'DECISION_CONFLICT' })
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      expect(liveTask('ok')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'approval.json' }] })
    })
    it('keeps the decision and its record when the final save fails, and finishes it on the same answer', async () => {
      await startFlow(approvalFlow()); await waiting()
      const recover = failWrites(okSucceeded)
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow(/ENOSPC/)
      recover()
      expect(liveTask('ok')).toMatchObject({ state: 'waiting', decision: { decision: 'ship' }, artifacts: [] })
      expect(readdirSync(join(live().root, 'artifacts', 'ok'))).toEqual(['attempt-1']) // the folder no saved state refers to
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      expect(liveTask('ok')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'approval.json' }] })
      expect(readdirSync(join(live().root, 'artifacts', 'ok'))).toEqual(['attempt-1'])
    })
    it('keeps a recorded decision over an expired deadline', async () => {
      await startFlow(approvalFlow({ timeout: '1h' })); await waiting()
      const recover = failWrites(okSucceeded)
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow(/ENOSPC/)
      recover()
      await internals().expire(live(), liveTask('ok'), 1)
      expect(liveTask('ok')).toMatchObject({ state: 'waiting', decision: { decision: 'ship' } })
    })
    it('finishes a recorded decision after a crash even when its deadline passed meanwhile', async () => {
      await startFlow(approvalFlow({ timeout: '1h' })); await waiting()
      const recover = failWrites(okSucceeded)
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow(/ENOSPC/)
      recover()
      const { run } = await restartOn(saved => { saved.tasks[1].deadline = Date.now() - 1000 })
      expect(run().tasks[1]).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'approval.json' }] })
      expect(readdirSync(join(run().root, 'artifacts', 'ok'))).toEqual(['attempt-1'])
    })
    it('keeps waiting across a daemon restart, and takes the answer afterwards', async () => {
      await startFlow(approvalFlow()); await waiting()
      const { next, run } = await restartOn()
      expect(run().tasks[1]).toMatchObject({ state: 'waiting', uncertain: false })
      await next.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      await vi.waitFor(() => expect(run().state).toBe('completed'))
    })
    it('lets a cancel win over a decision that is not finished yet', async () => {
      await startFlow(approvalFlow()); await waiting()
      const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
      vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => { service.cancel(flowId, 'ok'); return realRename(from, to) })
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      expect(liveTask('ok')).toMatchObject({ state: 'cancelled', decision: { decision: 'ship' } })
    })
    it('returns an approval interrupted while being prepared to the queue after a crash', async () => {
      await startFlow(approvalFlow()); await waiting()
      const { run } = await restartOn(saved => { saved.tasks[1].state = 'launching' })
      await vi.waitFor(() => expect(run().tasks[1]).toMatchObject({ state: 'waiting', uncertain: false, attempt: 1 }))
    })
    it('fails an approval nobody answered in time without retrying it, and refuses a late answer', async () => {
      await startFlow(approvalFlow({ timeout: '1h' })); await waiting()
      await internals().expire(live(), liveTask('ok'), 1)
      expect(liveTask('ok')).toMatchObject({ state: 'failed', error: 'No decision within 1h.' })
      expect(liveTask('ok').retryAt).toBeUndefined()
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    })
    it('refuses answers while the project is paused', async () => {
      await startFlow(approvalFlow()); await waiting()
      live().state = 'paused'
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'PROJECT_INACTIVE' })
    })
    it('lets a waiting approval take no parallelism slot', async () => {
      const g = gate('p')
      await startFlow(steps({ id: 'ok', approval: 'Go?' }, { id: 'a', run: g.run }, { id: 'b', run: g.run }, { id: 'c', run: g.run }))
      await vi.waitFor(() => expect(live().tasks.map(t => t.state)).toEqual(['waiting', 'running', 'running', 'running']))
      g.open()
    })
    it('refuses a cascade while an approval downstream waits', async () => {
      await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'ok', approval: 'Go?', depends_on: ['a'], trigger_rule: 'all_done' }))
      await waiting()
      expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'ok still uses this result; cancel ok first.' }))
    })
    it('pauses when the waiting state of an approval cannot be saved, and asks once on resume', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 'ok')?.state === 'waiting')
      await startFlow(approvalFlow())
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      expect(liveTask('ok')).toMatchObject({ state: 'launching', error: null })
      recover(); await service.resume(flowId)
      await waiting()
      expect(liveTask('ok').attempt).toBe(1)
      expect(live().messages.filter(m => m.text.startsWith('Task ok is waiting for approval'))).toHaveLength(1)
    })
    it('takes a plain approval without a decision', async () => {
      await startFlow(steps({ id: 'ok', approval: 'Go?' }))
      await waiting()
      expect(live().messages.at(-1)!.text).toBe('Task ok is waiting for approval: Go?')
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toMatchObject({ code: 'INVALID_DECISION' })
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', comment: '   ' }) // an empty comment is no comment
      expect(liveTask('ok')).toMatchObject({ state: 'succeeded', summary: 'Approved', error: null })
      expect(liveTask('ok').decision).not.toHaveProperty('comment')
      expect(JSON.parse(readFileSync(join(live().root, 'artifacts', 'ok', 'attempt-1', 'approval.json'), 'utf8'))).toEqual({ attempt: 1, outcome: 'approved', at: liveTask('ok').decision!.at })
      await expect(service.answer(flowId, 'build', 1, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
    })
    it('refuses an answer for a task that is not an approval', async () => {
      await startFlow(steps({ id: 'a', run: 'true' }))
      await expect(service.answer(flowId, 'a', 1, { outcome: 'rejected' })).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    })
    it('leaves a recorded decision alone in a reconcile once a cancel won while it waited for the attempt', async () => {
      await startFlow(approvalFlow()); await waiting()
      const recover = failWrites(okSucceeded)
      await expect(service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })).rejects.toThrow(/ENOSPC/)
      recover()
      let release!: () => void
      const held = internals().exclusive(live(), liveTask('ok'), 1, () => new Promise<void>(r => { release = r }))
      const waits = vi.spyOn(internals().finishing, 'get')
      const resuming = service.resume(flowId)
      await vi.waitFor(() => expect(waits).toHaveBeenCalledWith(`${flowId}/ok/1`)) // the reconcile waits for the attempt
      service.cancel(flowId, 'ok')
      release(); await held; await resuming
      expect(liveTask('ok')).toMatchObject({ state: 'cancelled', decision: { decision: 'ship' }, artifacts: [] })
      expect(live().messages.some(m => m.text.startsWith('Task ok attempt 1 succeeded'))).toBe(false)
    })
    it('fails an approval whose deadline passed while the daemon was down, without retrying it', async () => {
      await startFlow(approvalFlow({ timeout: '1h' })); await waiting()
      const { run } = await restartOn(saved => { saved.tasks[1].deadline = Date.now() - 1000 })
      expect(run().tasks[1]).toMatchObject({ state: 'failed', error: 'No decision within 1h.' })
      expect(run().tasks[1].retryAt).toBeUndefined()
    })
    it('keeps waiting after a restart with its deadline armed again', async () => {
      await startFlow(approvalFlow({ timeout: '1h' })); await waiting()
      const { next, run } = await restartOn()
      expect(run().tasks[1]).toMatchObject({ state: 'waiting', uncertain: false })
      expect([...(next as unknown as { deadlines: Map<string, unknown> }).deadlines.keys()]).toEqual([`${flowId}/ok/1`])
    })
    /** Holds the next approval.json write until the test lets it go on or fail. */
    const holdWrite = async (): Promise<() => Promise<{ go(): void; fail(error: Error): void }>> => {
      const realWrite = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
      let held: { go(): void; fail(error: Error): void } | undefined
      vi.mocked(filesystem.writeFile).mockImplementationOnce(async (...args: Parameters<typeof realWrite>) => {
        await new Promise<void>((resolve, reject) => { held = { go: resolve, fail: reject } })
        return realWrite(...args)
      })
      return () => vi.waitFor(() => { expect(held).toBeDefined(); return held! })
    }
    /** Two approvals; `go` has a recorded decision whose final save failed, so the next reconcile finishes it. */
    const decidedGo = async (): Promise<void> => {
      await startFlow(steps({ id: 'go', approval: 'Go?' }, { id: 'ok', approval: { message: 'Ship it?', decisions: [{ id: 'ship' }] } }))
      await vi.waitFor(() => expect(live().tasks.map(t => t.state)).toEqual(['waiting', 'waiting']))
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 'go')?.state === 'succeeded')
      await expect(service.answer(flowId, 'go', 1, { outcome: 'approved' })).rejects.toThrow(/ENOSPC/)
      recover()
    }
    it('takes an answer only once the reconcile of its run ended', async () => {
      await decidedGo()
      const held = await holdWrite()
      const resuming = service.resume(flowId), write = await held()
      const answering = service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      expect(liveTask('ok').decision).toBeUndefined() // it waits for the reconcile
      write.go(); await resuming; await answering
      expect(live().tasks.map(t => t.state)).toEqual(['succeeded', 'succeeded'])
    })
    it('refuses an answer that waited for a reconcile which paused the run again', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await decidedGo()
      const held = await holdWrite()
      const resuming = service.resume(flowId), write = await held()
      const answering = service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      write.fail(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }))
      await expect(resuming).rejects.toThrow(/EIO/)
      await expect(answering).rejects.toMatchObject({ code: 'PROJECT_INACTIVE' })
      expect(live().state).toBe('paused')
      expect(liveTask('ok').decision).toBeUndefined()
    })
    it.each(['cancelled', 'stopped'])('never pauses a run that was %s while a reconcile stored a decision', async how => {
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
      await decidedGo()
      const held = await holdWrite()
      const resuming = service.resume(flowId), write = await held()
      if (how === 'cancelled') service.cancel(flowId); else service.stop()
      write.fail(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }))
      await expect(resuming).rejects.toThrow(/EIO/)
      expect(live().state).toBe(how === 'cancelled' ? 'cancelled' : 'active')
      expect(onDisk().state).toBe(how === 'cancelled' ? 'cancelled' : 'active')
      expect(reported).toHaveBeenCalledWith(`[orchestrator] ${flowId}: reconcile failed: EIO: i/o error, write`)
    })
    it('keeps a decision and the pause reason when a pause wins while a reconcile stores it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await decidedGo()
      const held = await holdWrite()
      const resuming = service.resume(flowId), write = await held()
      ;(service as unknown as { pause(run: Run, error: unknown): void }).pause(live(), new Error('elsewhere'))
      write.go(); await resuming
      expect(live()).toMatchObject({ state: 'paused', error: expect.stringContaining('elsewhere') })
      expect(liveTask('go')).toMatchObject({ state: 'waiting', decision: { outcome: 'approved' }, artifacts: [] })
    })
    it('tells the person that a pause, not a cancel, interrupted their answer', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(approvalFlow()); await waiting()
      const held = await holdWrite()
      const answering = service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      const write = await held()
      ;(service as unknown as { pause(run: Run, error: unknown): void }).pause(live(), new Error('elsewhere'))
      write.go()
      await expect(answering).rejects.toMatchObject({ code: 'TASK_INACTIVE', message: 'The project was paused or stopped meanwhile; the decision is kept.' })
      expect(liveTask('ok')).toMatchObject({ state: 'waiting', decision: { decision: 'ship' } })
    })
    it('writes and publishes nothing more for an answer once a cancel wins during its record', async () => {
      await startFlow(approvalFlow()); await waiting()
      const realWrite = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
      let release: (() => void) | undefined
      vi.mocked(filesystem.writeFile).mockImplementationOnce(async (...args: Parameters<typeof realWrite>) => { await new Promise<void>(r => { release = r }); return realWrite(...args) })
      const answering = service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'ship' })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      service.cancel(flowId, 'ok')
      release!(); await answering
      expect(liveTask('ok')).toMatchObject({ state: 'cancelled', decision: { decision: 'ship' }, artifacts: [] })
      expect(existsSync(join(live().root, 'artifacts', 'ok'))).toBe(false)
      expect(live().messages.some(m => m.text.startsWith('Task ok attempt 1 succeeded'))).toBe(false)
    })
  })

  describe('cancel steps', () => {
    it('cancels the run from a cancel step before anything else can start', async () => {
      await startFlow(`spec: 1\nname: demo\ninputs: { who: { default: me } }\ntasks:
  - { id: check, run: 'exit 1' }
  - { id: long, run: 'sleep 30' }
  - { id: stop, cancel: 'check failed for $inputs.who', depends_on: [check], trigger_rule: all_done, when: 'check.state == failed' }
  - { id: next, run: 'true', depends_on: [stop] }
`)
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      expect(live().error).toBe('Cancelled by step stop: check failed for me')
      expect(live().tasks.map(t => [t.id, t.state])).toEqual([['check', 'failed'], ['long', 'cancelled'], ['stop', 'succeeded'], ['next', 'cancelled']])
      expect(liveTask('stop').summary).toBe('Cancelled the run: check failed for me')
      expect(onDisk().state).toBe('cancelled')
      await vi.waitFor(() => expect(internals().steps.size).toBe(0))
    })
    it('keeps the run cancelled and stops its work even when saving the cancel fails', async () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      const g = gate('gate')
      await startFlow(steps({ id: 'long', run: 'sleep 30' }, { id: 'gate', run: g.run }, { id: 'stop', cancel: 'now', depends_on: ['gate'] }))
      await vi.waitFor(() => { expect(liveTask('long').state).toBe('running'); expect(liveTask('gate').state).toBe('running') })
      failWrites(json => json.includes('"error":"Cancelled by step stop: now"'))
      g.open()
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      await vi.waitFor(() => expect(internals().steps.size).toBe(0))
      expect(liveTask('long').state).toBe('cancelled')
      expect(onDisk().state).toBe('active')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the cancel could not be saved'))
      await expect(service.resume(flowId)).rejects.toMatchObject({ code: 'PROJECT_INACTIVE' }) // the live run stays cancelled
    })
    it('ends a flow that holds only a cancel step as cancelled, not completed', async () => {
      await startFlow(steps({ id: 'stop', cancel: 'nothing to do' }))
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      expect(live().messages.some(m => m.text.includes('completed'))).toBe(false)
    })
    it('runs a ready cancel step before an earlier listed task whose launch cannot be saved', async () => {
      const g = gate('gate')
      await startFlow(steps({ id: 'gate', run: g.run }, { id: 'a', run: 'sleep 30', depends_on: ['gate'] }, { id: 'stop', cancel: 'now', depends_on: ['gate'] }))
      await vi.waitFor(() => expect(liveTask('gate').state).toBe('running'))
      failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks.find(t => t.id === 'a')?.state === 'launching')
      g.open()
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      expect(live().tasks.map(t => [t.id, t.state])).toEqual([['gate', 'succeeded'], ['a', 'cancelled'], ['stop', 'succeeded']])
      expect(onDisk().state).toBe('cancelled')
      await vi.waitFor(() => expect(internals().steps.size).toBe(0))
      expect(internals().launching.size).toBe(0)
    })
    it('runs a cancel step freed by a block before a task freed in the same pass can launch', async () => {
      await startFlow(steps(
        { id: 'check', run: 'exit 1' },
        { id: 'z', run: 'sleep 30', depends_on: ['check'], trigger_rule: 'all_done' },
        { id: 'b', run: 'true', depends_on: ['check'] },
        { id: 'stop', cancel: 'b was blocked', depends_on: ['b'], trigger_rule: 'all_done' },
      ))
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      expect(live().tasks.map(t => [t.id, t.state])).toEqual([['check', 'failed'], ['z', 'cancelled'], ['b', 'cancelled'], ['stop', 'succeeded']])
      expect(liveTask('z').attempt).toBe(1)
      expect(liveTask('z').cwd).toBe('') // never prepared
    })
    it('runs a cancel step made ready by a reconcile before guidance that waited is delivered', async () => {
      const sent: string[] = []
      deps.send = (_agent, _text, id) => { sent.push(id!) }
      await startFlow(steps(
        { id: 'w', harness: 'test/cad', prompt: 'p' },
        { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
        { id: 'stop', cancel: 'x is over', depends_on: ['x'], trigger_rule: 'all_done' },
      ))
      await vi.waitFor(() => { expect(liveTask('w').state).toBe('running'); expect(liveTask('x').state).toBe('running') })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1 // came due while paused
      const hold = holdVerdictRead()
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      const messageId = '6'.repeat(32)
      service.steer(flowId, 'w', 1, messageId, 'Use millimeters') // stays pending while the reconcile runs
      hold.release(); await resumed
      expect(live()).toMatchObject({ state: 'cancelled', error: 'Cancelled by step stop: x is over' })
      expect(sent).not.toContain(messageId)
      expect(live().messages.find(m => m.id === messageId)).toMatchObject({ delivery: 'failed', deliveryReason: 'Cancelled before delivery.' })
      expect(cancelled).toContain(liveTask('w').agentId)
    })
    it('skips a branch decided false before a cancel step made ready by the same decision stops the run', async () => {
      await startFlow(steps(
        { id: 'ok', approval: { message: 'Open the PR?', decisions: [{ id: 'ship' }, { id: 'rework' }] } },
        { id: 'open-pr', run: 'true', depends_on: ['ok'], when: 'ok.decision == ship' },
        { id: 'stop-if-rework', cancel: 'Rework requested', depends_on: ['ok'], when: 'ok.decision == rework' },
      ))
      await vi.waitFor(() => expect(liveTask('ok').state).toBe('waiting'))
      await service.answer(flowId, 'ok', 1, { outcome: 'approved', decision: 'rework' })
      expect(live()).toMatchObject({ state: 'cancelled', error: 'Cancelled by step stop-if-rework: Rework requested' })
      expect(live().tasks.map(t => [t.id, t.state])).toEqual([['ok', 'succeeded'], ['open-pr', 'skipped'], ['stop-if-rework', 'succeeded']])
      expect(liveTask('open-pr').summary).toBe('Skipped: ok.decision == ship is false.')
    })
    it('keeps the reason of a cancel step when the cancelled project is cancelled again', async () => {
      await startFlow(steps({ id: 'stop', cancel: 'nothing to do' }))
      await vi.waitFor(() => expect(live().state).toBe('cancelled'))
      service.cancel(flowId)
      expect(live()).toMatchObject({ state: 'cancelled', error: 'Cancelled by step stop: nothing to do' })
      expect(onDisk().error).toBe('Cancelled by step stop: nothing to do')
    })
    it('runs a cancel step made ready by a reconcile before a requested loop check starts', async () => {
      const spawned = vi.fn(sh); deps.spawnStep = spawned
      await startFlow(steps(
        { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
        { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
        { id: 'stop', cancel: 'x is over', depends_on: ['x'], trigger_rule: 'all_done' },
      ))
      await vi.waitFor(() => { expect(liveTask('x').state).toBe('running'); expect(liveTask('fix').state).toBe('running') })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1 // came due while paused
      liveTask('fix').loopState!.phase = 'check-requested'
      await service.resume(flowId)
      expect(live()).toMatchObject({ state: 'cancelled', error: 'Cancelled by step stop: x is over' })
      expect(spawned).not.toHaveBeenCalled()
      expect(internals().checks.size).toBe(0)
    })
    it('never moves a cancelled project to paused after a late background error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(steps({ id: 'a', harness: 'test/cad', prompt: 'work' }))
      service.cancel(flowId)
      ;(internals() as unknown as { pause(run: Run, error: unknown): void }).pause(live(), new Error('late'))
      expect(live().state).toBe('cancelled')
    })
  })

  const flowDir = () => { const d = join(project, '.harness/flows'); mkdirSync(d, { recursive: true }); return d }
  it('records the scripts a shell step names', async () => {
    writeFileSync(join(flowDir(), 's.sh'), 'echo hi')
    await startFlow(steps({ id: 's', run: 'sh "$HARNESS_FLOW_DIR/s.sh"' }))
    await vi.waitFor(() => expect(liveTask('s').state).toBe('succeeded'))
    expect(liveTask('s').scripts).toEqual([{ path: join(flowDir(), 's.sh'), sha256: createHash('sha256').update('echo hi').digest('hex') }])
  })
  it('does not start a step cancelled while its scripts are hashed', async () => {
    writeFileSync(join(flowDir(), 's.sh'), 'echo hi')
    const spawned = vi.fn(sh); deps.spawnStep = spawned
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
    let release: (() => void) | undefined
    vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('s.sh') && !release) await new Promise<void>(r => { release = r })
      return realOpen(path, flags, mode)
    })
    await startFlow(steps({ id: 's', run: 'sh "$HARNESS_FLOW_DIR/s.sh"' }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    service.cancel(flowId, 's')
    release!()
    await vi.waitFor(() => expect(internals().launching.size).toBe(0))
    expect(spawned).not.toHaveBeenCalled()
    expect(liveTask('s').state).toBe('cancelled')
  })
  describe('loops', () => {
    const sentTo = (agent: string) => sends.filter(([a]) => a === agent).map(([, text]) => text)
    const turn = (type: 'turn_started' | 'turn_ended', extra: Record<string, unknown> = {}) => service.ingest({ type, agentId: 'agent-1', payload: {}, ...extra })
    const loopFlow = (check: string, max = 3, extra: Record<string, unknown> = {}) => steps({ id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: check, max_iterations: max }, timeout: '1h', ...extra })
    const checked = () => liveTask('fix').loopState!
    /** Records agent creations and cancellations in the order they happen. */
    const recordOrder = (): string[] => {
      const order: string[] = [], create = deps.create
      deps.create = async input => { order.push('create'); return create(input) }
      deps.cancel = agent => { cancelled.push(agent); order.push(`cancel ${agent}`) }
      return order
    }

    it('records the scripts of the last loop check, even when the check ends first', async () => {
      writeFileSync(join(flowDir(), 'c.sh'), 'exit 1')
      const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
      let release: (() => void) | undefined
      vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
        if (String(path).endsWith('c.sh') && !release) await new Promise<void>(r => { release = r })
        return realOpen(path, flags, mode)
      })
      await startFlow(loopFlow('sh "$HARNESS_FLOW_DIR/c.sh"'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await (internals().checks.values().next().value as { handle: { done: Promise<unknown> } }).handle.done // the check itself has ended
      expect(checked().phase).toBe('checking') // its result waits for the hashes
      release!()
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1 }))
      expect(liveTask('fix').scripts).toEqual([{ path: join(flowDir(), 'c.sh'), sha256: createHash('sha256').update('exit 1').digest('hex') }])
    })
    it('applies a passing check seen before the deadline on resume, although its scripts were still hashed when the run paused', async () => {
      writeFileSync(join(flowDir(), 'c.sh'), 'exit 0')
      const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
      let release: (() => void) | undefined
      vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
        if (String(path).endsWith('c.sh') && !release) await new Promise<void>(r => { release = r })
        return realOpen(path, flags, mode)
      })
      await startFlow(loopFlow('sh "$HARNESS_FLOW_DIR/c.sh"'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // the check has passed; its result waits for the hashes
      const seen = [...internals().pending.values()][0].at
      live().state = 'paused'; liveTask('fix').deadline = seen + 1 // ahead when the result was seen
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(seen + 1)) // passed before the resume
      const resumed = service.resume(flowId)
      release!()
      await resumed
      expect(liveTask('fix')).toMatchObject({ state: 'succeeded', scripts: [{ path: join(flowDir(), 'c.sh') }] })
      expect(internals().pending.size).toBe(0)
    })
    it('clears the scripts of the last loop check when it names none any more', async () => {
      writeFileSync(join(flowDir(), 'c.sh'), 'exit 1')
      await startFlow(loopFlow('sh "$HARNESS_FLOW_DIR/c.sh"'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().completed).toBe(1))
      expect(liveTask('fix').scripts).toHaveLength(1)
      rmSync(join(flowDir(), 'c.sh')) // the second check names a file that is gone: its hash result is empty
      turn('turn_started'); turn('turn_ended')
      await vi.waitFor(() => expect(checked().completed).toBe(2))
      expect(liveTask('fix').scripts).toBeUndefined()
    })
    it('checks after each turn, sends the failure back, and succeeds once the check passes', async () => {
      await startFlow(loopFlow('test -f "$HARNESS_PROJECT_DIR/fixed" || { echo still broken >&2; exit 1; }'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      expect(checked()).toEqual({ phase: 'working', completed: 0, turn: 0 })
      turn('turn_ended', { payload: { aborted: true } })
      expect(checked().phase).toBe('working') // an aborted end starts nothing
      turn('turn_ended')
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1, eligibleAfter: 0 }))
      expect(sentTo('agent-1').at(-1)).toMatch(/^\[Orchestrator update\]\nCheck failed \(exit 1\), iteration 1 of 3\./)
      expect(sentTo('agent-1').at(-1)).toContain('still broken')
      writeFileSync(join(project, 'fixed'), '')
      turn('turn_started'); turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'succeeded', summary: 'Check passed: test -f "$HARNESS_PROJECT_DIR/fixed" || { echo still broken >&2; exit 1; } (iteration 2 of 3). Log: .harness/loop/2.stdout.log' }))
      expect(checked().completed).toBe(2)
      expect(checked().check).toBeUndefined()
    })
    it('starts no second check for the late end of a turn that was already checked, nor for replayed frames', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_started', { replay: true }); expect(checked().turn).toBe(0)
      turn('turn_ended')
      await vi.waitFor(() => expect(checked()).toMatchObject({ completed: 1, phase: 'working' }))
      turn('turn_ended'); turn('turn_ended', { replay: true }) // the old end, again and replayed
      expect(checked().phase).toBe('working'); expect(internals().checks.size).toBe(0)
      turn('turn_started'); turn('turn_ended') // a turn that started after the feedback
      expect(checked().phase).toBe('checking')
    })
    it.each([1, 3])('fails when check number %i (the last allowed) fails', async max => {
      await startFlow(loopFlow('exit 1', max))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      for (let i = 1; i <= max; i++) {
        if (i > 1) turn('turn_started')
        turn('turn_ended')
        if (i < max) await vi.waitFor(() => expect(checked()).toMatchObject({ completed: i, phase: 'working' }))
      }
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: `Check still failing after ${max} iteration${max === 1 ? '' : 's'}: exit 1. Log: .harness/loop/${max}.stderr.log` }))
      expect(checked().completed).toBe(max)
      expect(sentTo('agent-1').filter(t => t.startsWith('[Orchestrator update]\nCheck failed'))).toHaveLength(max - 1)
      expect(cancelled).toContain('agent-1')
    })
    it('records finish and runs the check only when that turn ends; a steer turn during a failing check starts nothing', async () => {
      const g = gate('check')
      await startFlow(loopFlow(`${g.run}; exit 1`))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'out.txt'), 'x')
      expect(await orchestratorRequest(service, { action: 'finish', id: flowId, taskId: 'fix', attempt: 1, summary: 'did it', artifacts: ['out.txt'] })).toMatchObject({ notice: 'Recorded. The check runs when this turn ends.' })
      expect(checked()).toMatchObject({ phase: 'working', finish: { summary: 'did it', paths: ['out.txt'] } })
      turn('turn_ended')
      expect(checked().phase).toBe('checking')
      turn('turn_started'); turn('turn_ended') // a steer turn while checking
      expect(internals().checks.size).toBe(1)
      g.open()
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1, turn: 1, eligibleAfter: 1 }))
      turn('turn_ended') // still the steer turn
      expect(checked().phase).toBe('working')
    })
    it('keeps the recorded summary and adds the check log when the check passes', async () => {
      await startFlow(loopFlow('true'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'out.txt'), 'x')
      await service.finish(flowId, 'fix', 1, 'did it', ['out.txt'])
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'succeeded', summary: 'did it\nCheck passed (iteration 1 of 3). Log: .harness/loop/1.stdout.log', artifacts: [{ path: 'out.txt' }] }))
    })
    it.each([
      ['an explicit fail', async () => { await service.finish(flowId, 'fix', 1, 'giving up', [], true) }, 'giving up'],
      ['the attempt timeout', async () => { await internals().expire(live(), liveTask('fix'), 1) }, 'Timed out after 1h.'],
      ['a task cancel', async () => { service.cancel(flowId, 'fix') }, null],
    ])('ends the attempt and stops the check on %s', async (_name, end, error) => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().check?.pid).toEqual(expect.any(Number)))
      await end()
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      expect(liveTask('fix').state).toBe(error === null ? 'cancelled' : 'failed')
      if (error) expect(liveTask('fix').error).toBe(error)
    })
    it('fails the attempt when the check itself times out', async () => {
      deps.checkTimeoutMs = 300 // read when the check starts
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The loop check timed out after 300 ms. Log: .harness/loop/1.stderr.log' }))
    })
    it('fails without a retry when the check cannot start', async () => {
      await startFlow(loopFlow('true', 3, { retry: { max_attempts: 2 } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      deps.spawnStep = () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) }
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The loop check could not start: the shell could not be found (ENOENT). There is no log: the shell never started.' }))
      expect(liveTask('fix').retryAt).toBeUndefined()
    })
    it('pauses the idle clock while a check runs', async () => {
      const g = gate('check')
      await startFlow(loopFlow(`${g.run}; exit 1`, 3, { idle_timeout: '1h' }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      expect(internals().idleTimers.size).toBe(1)
      turn('turn_ended')
      expect(internals().idleTimers.size).toBe(0)
      turn('turn_started') // activity during a check does not start the clock
      expect(internals().idleTimers.size).toBe(0)
      g.open()
      await vi.waitFor(() => expect(checked().completed).toBe(1))
      expect(internals().idleTimers.size).toBe(1) // the feedback starts it again
    })
    it('keeps a check result that arrives while paused and applies it on resume', async () => {
      const g = gate('check')
      await startFlow(loopFlow(`${g.run}; exit 1`))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      live().state = 'paused'
      g.open()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      expect(checked().phase).toBe('checking')
      await service.resume(flowId)
      expect(checked()).toMatchObject({ phase: 'working', completed: 1 })
    })
    it('stops a check whose pid cannot be saved, and fails the attempt on resume', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].loopState?.check?.pid !== undefined)
      turn('turn_ended')
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      recover(); await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^The loop check failed: its process id could not be saved \(ENOSPC.*\)\. Log: \.harness\/loop\/1\.stderr\.log$/) })
    })
    it('blocks the task as uncertain when its check could not be confirmed stopped, and keeps owning the check', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await startFlow(loopFlow('x'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep() // the check is spawned through deps.spawnStep too
      turn('turn_ended')
      await check.end()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'blocked', uncertain: true, error: 'A loop check may still be running (pid 999999). Make sure it stopped before retrying.' }))
      expect(internals().checks.size).toBe(1)
      expect(cancelled).toContain('agent-1')
      expect(() => service.retry(flowId, 'fix')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: 'This loop check may still be running (pid 999999). Stop that process, then retry.' }))
      check.gone()
      service.retry(flowId, 'fix')
      expect(internals().checks.size).toBe(0)
    })
    it('reserves .harness/loop: outputs skip it and finish cannot name it, not even through a symlink', async () => {
      await startFlow(loopFlow('true', 3, { outputs: { files: ['**/*.log'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const cwd = liveTask('fix').cwd
      mkdirSync(join(cwd, '.harness/loop'), { recursive: true }); writeFileSync(join(cwd, '.harness/loop/1.stdout.log'), 'x')
      symlinkSync(join(cwd, '.harness/loop'), join(cwd, 'alias'))
      await expect(service.finish(flowId, 'fix', 1, 'x', ['.harness/loop/1.stdout.log'])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
      await expect(service.finish(flowId, 'fix', 1, 'x', ['alias/1.stdout.log'])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
      turn('turn_ended')
      await vi.waitFor(() => expect(sentTo('agent-1').at(-1)).toContain('outputs missing: **/*.log'))
    })
    it('never finishes a loop task from its outputs alone', async () => {
      await startFlow(loopFlow('exit 1', 3, { outputs: { files: ['out.txt'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'out.txt'), 'x')
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().completed).toBe(1))
      expect(liveTask('fix').state).toBe('running')
    })
    it('snapshots the finish acknowledged last, also one recorded while the check ran', async () => {
      const g = gate('check')
      await startFlow(loopFlow(g.run))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'a.txt'), 'a'); writeFileSync(join(liveTask('fix').cwd, 'b.txt'), 'b')
      await service.finish(flowId, 'fix', 1, 'v1', ['a.txt'])
      turn('turn_ended')
      expect(checked().phase).toBe('checking')
      expect(await service.finish(flowId, 'fix', 1, 'v2', ['b.txt'])).toBe('recorded') // latest wins, any phase
      g.open()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'succeeded', summary: 'v2\nCheck passed (iteration 1 of 3). Log: .harness/loop/1.stdout.log', artifacts: [{ path: 'b.txt' }] }))
    })
    it('fails the attempt, without a pause, when a file named by finish cannot be kept after the check passed', async () => {
      const g = gate('check')
      await startFlow(loopFlow(g.run, 3, { retry: { max_attempts: 2, delay: '60s' } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'a.txt'), 'a')
      await service.finish(flowId, 'fix', 1, 'v1', ['a.txt'])
      turn('turn_ended')
      unlinkSync(join(liveTask('fix').cwd, 'a.txt')) // deleted before the passing check ends
      g.open()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: expect.stringMatching(/^The check passed, but the files named by finish could not be kept: ENOENT.*a\.txt'\.$/), artifacts: [] }))
      expect(live().state).toBe('active')
      expect(liveTask('fix').retryAt).toEqual(expect.any(Number)) // retryable under the task's policy
      expect(checked()).toMatchObject({ completed: 1 })
      expect(checked().check).toBeUndefined()
      expect(internals().pending.size).toBe(0)
      expect(cancelled).toContain('agent-1') // the worker does not outlive its attempt
    })
    it('cancels the worker whose passed check could not keep its files before the retry creates another', async () => {
      const order = recordOrder()
      await startFlow(loopFlow('true', 3, { retry: { max_attempts: 2 } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'a.txt'), 'a')
      await service.finish(flowId, 'fix', 1, 'v1', ['a.txt'])
      unlinkSync(join(liveTask('fix').cwd, 'a.txt'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2 }))
      expect(order).toEqual(['create', 'cancel agent-1', 'create'])
      expect(live().messages.some(m => m.text.includes('The check passed, but the files named by finish could not be kept'))).toBe(true)
    })
    it('refuses a finish that comes after the loop task succeeded', async () => {
      await startFlow(loopFlow('true'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('succeeded'))
      await expect(service.finish(flowId, 'fix', 1, 'late', [])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    })
    it('counts a turn that starts while the run is paused, so its end after the resume runs the check', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1, eligibleAfter: 0 }))
      live().state = 'paused'
      turn('turn_started')
      expect(checked().turn).toBe(1)
      await service.resume(flowId)
      turn('turn_ended')
      expect(checked().phase).toBe('checking')
    })
    it('requests the check for a turn that ends while the run is paused, and runs it on resume', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      live().state = 'paused'
      turn('turn_ended')
      expect(checked().phase).toBe('check-requested')
      expect(onDisk().tasks[0].loopState!.phase).toBe('check-requested')
      expect(internals().checks.size).toBe(0)
      await service.resume(flowId)
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1 }))
      expect(existsSync(join(liveTask('fix').cwd, '.harness/loop/1.stderr.log'))).toBe(true)
    })
    it.each([
      ['the attempt timeout', false],
      ['an attempt timeout that cannot be saved', true],
      ['an explicit fail', false],
    ] as const)('stops a check that a turn started while %s was being settled', async (name, unsaved) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const hold = holdVerdictRead() // the settlement waits here
      if (unsaved) failWrites(json => json.includes('Timed out after 1h.'))
      const ending = name === 'an explicit fail' ? service.finish(flowId, 'fix', 1, 'giving up', [], true) : internals().expire(live(), liveTask('fix'), 1)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      turn('turn_ended') // the attempt is still running: this starts a check
      await vi.waitFor(() => expect(checked().check?.pid).toEqual(expect.any(Number)))
      hold.release(); await ending
      if (unsaved) expect(live()).toMatchObject(pausedByDisk)
      else expect(liveTask('fix').state).toBe('failed')
      await vi.waitFor(() => expect(internals().checks.size).toBe(0)) // stopped, not left to run
    })
    it('keeps a passed check for the resume when its files cannot be stored', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('true'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'a.txt'), 'a')
      await service.finish(flowId, 'fix', 1, 'v1', ['a.txt'])
      vi.mocked(filesystem.copyFile).mockImplementationOnce(async (from, to) => { throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC', path: String(from), dest: String(to) }) })
      turn('turn_ended')
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      expect(liveTask('fix').state).toBe('running')
      expect(internals().pending.size).toBe(1)
      await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'a.txt' }] })
    })
    it('makes a finish that comes while the success is being saved wait, and refuses it afterwards', async () => {
      await startFlow(loopFlow('true'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'a.txt'), 'a')
      await service.finish(flowId, 'fix', 1, 'v1', ['a.txt'])
      const hold = holdVerdictRead() // the success owns the attempt and waits here
      turn('turn_ended')
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      const late = service.finish(flowId, 'fix', 1, 'v2', [])
      hold.release()
      await expect(late).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
      expect(liveTask('fix').summary.startsWith('v1\n')).toBe(true)
    })
    it('changes nothing when loop feedback cannot be saved, and sends it once on resume', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].loopState?.feedbackId !== undefined)
      turn('turn_ended')
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      expect(checked()).toMatchObject({ phase: 'checking', completed: 0 })
      expect(sentTo('agent-1')).toHaveLength(0)
      expect(internals().pending.size).toBe(1)
      recover(); await service.resume(flowId)
      expect(checked()).toMatchObject({ phase: 'working', completed: 1 })
      expect(sentTo('agent-1').filter(t => t.startsWith('[Orchestrator update]\nCheck failed'))).toHaveLength(1)
    })
    it('keeps loop feedback pending when its hand-off cannot be saved, and sends it exactly once on resume', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).messages.some(m => m.delivery === 'accepted'))
      turn('turn_ended')
      await vi.waitFor(() => expect(live()).toMatchObject(pausedByDisk))
      const feedback = () => live().messages.find(m => m.id === checked().feedbackId)!
      expect(checked()).toMatchObject({ phase: 'working', completed: 1 })
      expect(feedback().delivery).toBe('pending')
      expect(sentTo('agent-1')).toHaveLength(0)
      recover(); await service.resume(flowId)
      expect(sentTo('agent-1').filter(t => t.startsWith('[Orchestrator update]\nCheck failed'))).toHaveLength(1)
      expect(feedback().delivery).toBe('accepted')
      expect(onDisk().messages.find(m => m.id === checked().feedbackId)!.delivery).toBe('accepted')
    })
    it.each(['a resume after the deadline', 'the timeout'] as const)('lets a check that passed before the deadline win over %s while its outputs are checked', async how => {
      await startFlow(loopFlow('true', 3, { outputs: { files: ['out.txt'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'out.txt'), 'x')
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).checkOutputs
      let release: (() => void) | undefined
      vi.mocked(outputsModule.checkOutputs).mockImplementationOnce(async (...args) => { await new Promise<void>(r => { release = r }); return actual(...args) })
      turn('turn_ended')
      await vi.waitFor(() => expect(release).toBeTypeOf('function')) // the check passed; its outputs are being looked at
      const deadline = Date.now() + 1 // ahead when the result was seen
      liveTask('fix').deadline = deadline
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(deadline))
      if (how === 'the timeout') await internals().expire(live(), liveTask('fix'), 1)
      else { live().state = 'paused'; await service.resume(flowId) }
      release!()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'out.txt' }] }))
      await vi.waitFor(() => expect(internals().pending.size).toBe(0))
      expect(live().messages.some(m => m.text.includes('Timed out'))).toBe(false)
    })
    it('lets go of a passed check whose attempt failed while its outputs were looked at, so a retry is not held back', async () => {
      await startFlow(loopFlow('true', 3, { outputs: { files: ['out.txt'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).checkOutputs
      let release: (() => void) | undefined
      vi.mocked(outputsModule.checkOutputs).mockImplementationOnce(async (...args) => { await new Promise<void>(r => { release = r }); return actual(...args) })
      turn('turn_ended')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await service.finish(flowId, 'fix', 1, 'giving up', [], true)
      release!()
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      expect(internals().pending.size).toBe(0)
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'giving up' })
      service.retry(flowId, 'fix')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2 }))
    })
    it('lets go of a passed check whose attempt was cancelled while its success was being saved', async () => {
      await startFlow(loopFlow('true'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const hold = holdVerdictRead() // the success owns the attempt and waits here
      turn('turn_ended')
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      service.cancel(flowId, 'fix')
      hold.release()
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      expect(internals().pending.size).toBe(0)
      expect(liveTask('fix').state).toBe('cancelled')
      service.retry(flowId, 'fix')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2 }))
    })
    it('keeps a passed check when the run pauses while its outputs are checked', async () => {
      await startFlow(loopFlow('true', 3, { outputs: { files: ['out.txt'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      writeFileSync(join(liveTask('fix').cwd, 'out.txt'), 'x')
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).checkOutputs
      let release: (() => void) | undefined
      vi.mocked(outputsModule.checkOutputs).mockImplementationOnce(async (...args) => { await new Promise<void>(r => { release = r }); return actual(...args) })
      turn('turn_ended')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      live().state = 'paused'
      release!()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'succeeded', artifacts: [{ path: 'out.txt' }] })
    })
    it('retries a loop task with a new agent and a fresh loop', async () => {
      await startFlow(loopFlow('exit 1', 1))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('failed'))
      service.retry(flowId, 'fix')
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2, agentId: 'agent-2' }))
      expect(checked()).toEqual({ phase: 'working', completed: 0, turn: 0 })
    })
    it('refuses a cascade while a dependent loop check still runs', async () => {
      await startFlow(steps({ id: 'a', run: 'exit 1' }, { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'sleep 30', max_iterations: 2 }, timeout: '1h', depends_on: ['a'], trigger_rule: 'all_done' }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(internals().checks.size).toBe(1))
      await service.finish(flowId, 'fix', 1, 'giving up', [], true) // fix failed; its check is still being stopped
      expect(() => service.retry(flowId, 'a')).toThrow(expect.objectContaining({ code: 'RESULT_IN_USE', message: 'fix still uses this result; cancel fix first.' }))
    })
    it('fences a loop task that already failed when its check could not be confirmed stopped', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await startFlow(loopFlow('x', 3, { retry: { max_attempts: 2 } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep() // the check is spawned through deps.spawnStep too
      turn('turn_ended')
      await internals().expire(live(), liveTask('fix'), 1) // failed with a due retry, the check is being stopped
      expect(liveTask('fix').retryAt).toEqual(expect.any(Number))
      await check.end()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'blocked', uncertain: true, attempt: 1 }))
      expect(liveTask('fix').retryAt).toBeUndefined()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(launches).toHaveLength(1) // no new agent
    })
    it('cancels the old worker before the replacement when a check failure kept while paused is applied', async () => {
      const order = recordOrder()
      const g = gate('check')
      await startFlow(loopFlow(`${g.run}; exit 1`, 1, { retry: { max_attempts: 2 } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      live().state = 'paused'
      g.open()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      await service.resume(flowId)
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2 }))
      expect(order).toEqual(['create', 'cancel agent-1', 'create'])
    })
    it('cancels the old worker when a check failure seen during a reconcile is applied', async () => {
      const order = recordOrder()
      const g = gate('check')
      await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: `${g.run}; exit 1`, max_iterations: 1 }, timeout: '1h', retry: { max_attempts: 2 } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const hold = holdVerdictRead() // x's expiry holds the reconcile
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      g.open()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1)) // the raw result waits for the barrier
      hold.release(); await resumed
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'running', attempt: 2 }))
      expect(order.indexOf('cancel agent-2')).toBeGreaterThan(-1)
      expect(order.indexOf('cancel agent-2')).toBeLessThan(order.lastIndexOf('create'))
    })
    it('cancels the worker when an uncertainty kept while paused is applied', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await startFlow(loopFlow('x'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep()
      turn('turn_ended')
      live().state = 'paused'
      await check.end()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      expect(cancelled).not.toContain('agent-1')
      await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'blocked', uncertain: true })
      expect(cancelled).toContain('agent-1')
    })
    it('still times out a loop task whose kept check result is applied after its deadline, before any feedback goes out', async () => {
      const g = gate('check')
      await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: `${g.run}; exit 1`, max_iterations: 3 }, timeout: '1h' }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const fixAgent = liveTask('fix').agentId!
      service.ingest({ type: 'turn_ended', agentId: fixAgent, payload: {} })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const hold = holdVerdictRead() // x's expiry holds step 4
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      g.open() // the check fails below the limit: a feedback result, kept because the barrier is up
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      const seen = [...internals().pending.values()][0].at
      liveTask('fix').deadline = seen + 1 // ahead when the result was seen
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(seen + 1)) // passed before step 4 reaches fix
      hold.release(); await resumed
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
      expect(sentTo(fixAgent).some(text => text.includes('Check failed'))).toBe(false) // the feedback never went out
      expect(live().messages.find(m => m.id === liveTask('fix').loopState!.feedbackId)).toMatchObject({ delivery: 'failed', deliveryReason: 'The attempt ended before this feedback was delivered.' })
      expect(internals().checks.size).toBe(0) // no further check
    })
    it('ignores the turns of a loop task that no longer runs', async () => {
      await startFlow(loopFlow('exit 1', 1))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('failed'))
      const before = checked()
      turn('turn_started'); turn('turn_ended')
      expect(checked()).toEqual(before)
      expect(internals().checks.size).toBe(0)
    })
    it('pauses the run when a turn of a loop task cannot be counted', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].loopState?.turn === 1)
      turn('turn_started')
      expect(live()).toMatchObject(pausedByDisk)
      expect(checked().turn).toBe(0)
    })
    it('names the pid of a check that may still run even when that pid was never saved', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('x'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep()
      const recover = failWrites(json => json.startsWith('{"version"') && (JSON.parse(json) as Run).tasks[0].loopState?.check?.pid !== undefined)
      turn('turn_ended')
      expect(live()).toMatchObject(pausedByDisk)
      await check.end()
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      recover(); await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'blocked', uncertain: true, error: 'A loop check may still be running (pid 999999). Make sure it stopped before retrying.' })
    })
    it('names the default time limit of a check that timed out', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await startFlow(loopFlow('x'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep()
      turn('turn_ended')
      await vi.advanceTimersByTimeAsync(120_000) // the check's own limit: it is told to stop
      check.gone(); await check.end()
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The loop check timed out after 2m. Log: .harness/loop/1.stderr.log' }))
    })
    it('sends feedback when the outputs of a passed check cannot be looked at', async () => {
      await startFlow(loopFlow('true', 3, { outputs: { files: ['out.txt'] } }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      vi.mocked(outputsModule.checkOutputs).mockRejectedValueOnce(new Error('boom'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1 }))
      expect(sentTo('agent-1').at(-1)).toMatch(/^\[Orchestrator update\]\nCheck failed \(outputs missing\), iteration 1 of 3\.[^]*outputs missing: outputs not checked: boom$/)
    })
    it('keeps check feedback for the resume when the run pauses while it waits for the attempt', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const owner = internals().exclusive(live(), liveTask('fix'), 1, () => held) // something else owns the attempt
      const applying = vi.spyOn(internals() as unknown as { finishCheck(...args: unknown[]): Promise<void> }, 'finishCheck')
      turn('turn_ended')
      await vi.waitFor(() => expect(applying).toHaveBeenCalled()) // the result arrived and waits for the owner
      live().state = 'paused'
      release(); await owner
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      expect(checked()).toMatchObject({ phase: 'checking', completed: 0 })
      expect(sentTo('agent-1')).toHaveLength(0)
      await service.resume(flowId)
      expect(checked()).toMatchObject({ phase: 'working', completed: 1 })
      expect(sentTo('agent-1')).toHaveLength(1)
    })
    it('stops the loop check at once when its timeout cannot be saved', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().check?.pid).toEqual(expect.any(Number)))
      const recover = failWrites(json => json.includes('Timed out after 1h.'))
      await internals().expire(live(), liveTask('fix'), 1)
      expect(live()).toMatchObject(pausedByDisk)
      expect(cancelled).toContain('agent-1')
      await vi.waitFor(() => expect(internals().checks.size).toBe(0)) // the check was stopped, not left to run
      expect(liveTask('fix').state).toBe('running') // the timeout itself waits for the resume
      recover(); await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
    })

    it('treats a check that may still run after a crash as uncertain, and allows a retry once it is gone', async () => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().check?.pid).toEqual(expect.any(Number)))
      const left = orphan()
      const { next, run } = await restartOn(saved => { saved.tasks[0].loopState!.check!.pid = left.pid })
      expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, error: `A loop check may still be running (pid ${left.pid}). Make sure it stopped before retrying.` })
      expect(() => next.retry(flowId, 'fix')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE' }))
      process.kill(-left.pid, 'SIGKILL')
      await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
      next.retry(flowId, 'fix')
      expect(run().tasks[0].attempt).toBe(2)
    })
    it('runs a check again after a restart when its process is gone, with the same number', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const ended = await exitedPid('true', []); await ended.exited
      const { run } = await restartOn(saved => { saved.tasks[0].loopState = { phase: 'checking', completed: 0, turn: 0, check: { pid: ended.pid, startedAt: Date.now() } } })
      await vi.waitFor(() => expect(run().tasks[0].loopState).toMatchObject({ phase: 'working', completed: 1 }))
      expect(existsSync(join(run().tasks[0].cwd, '.harness/loop/1.stderr.log'))).toBe(true)
    })
    it('treats a check whose pid was never saved as uncertain after a crash', async () => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const { run } = await restartOn(saved => { saved.tasks[0].loopState = { phase: 'checking', completed: 0, turn: 0, check: { startedAt: Date.now() } } })
      expect(run().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, error: 'A loop check may still be running (pid unknown). Make sure it stopped before retrying.' })
    })
    it('enforces an expired deadline before a recovered check starts', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const { next, run } = await restartOn(saved => { saved.tasks[0].loopState = { phase: 'check-requested', completed: 0, turn: 0 }; saved.tasks[0].deadline = Date.now() - 1 })
      expect(run().tasks[0]).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' })
      expect((next as unknown as { checks: Map<string, unknown> }).checks.size).toBe(0)
      expect(existsSync(join(run().tasks[0].cwd, '.harness/loop/1.stdout.log'))).toBe(false)
    })
    it('defers a check requested during a reconcile until the deadlines were enforced', async () => {
      await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const hold = holdVerdictRead()
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      expect(checked().phase).toBe('check-requested')
      expect(internals().checks.size).toBe(0)
      hold.release(); await resumed
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1 }))
    })
    it('starts a check requested during the last phase of a reconcile once the barrier is down', async () => {
      await startFlow(steps(
        { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
        { id: 'w', harness: 'test/cad', prompt: 'p', outputs: { files: ['out.txt'] } },
        { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
      ))
      await vi.waitFor(() => { for (const id of ['x', 'w', 'fix']) expect(liveTask(id).state).toBe('running') })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).readVerdictSnapshot
      const gates: (() => void)[] = []
      const held = async (dir: string) => { await new Promise<void>(r => { gates.push(r) }); return actual(dir) }
      vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(held).mockImplementationOnce(held) // x's expiry, then w's result
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(gates).toHaveLength(1)) // step 4 holds on x
      writeFileSync(join(liveTask('w').cwd, 'out.txt'), 'x')
      service.ingest({ type: 'turn_ended', agentId: liveTask('w').agentId, payload: {} }) // kept: a reconcile runs
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      gates[0]()
      await vi.waitFor(() => expect(gates).toHaveLength(2)) // the last phase's drain holds on w: step 5 has passed
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      expect(checked().phase).toBe('check-requested')
      gates[1](); await resumed
      expect(liveTask('w').state).toBe('succeeded')
      await vi.waitFor(() => expect(checked()).toMatchObject({ phase: 'working', completed: 1 }))
    })
    it('starts no requested check once the run was cancelled during the reconcile', async () => {
      await startFlow(steps({ id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' }, { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' }))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const hold = holdVerdictRead() // x's expiry holds step 4
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      expect(checked().phase).toBe('check-requested')
      service.cancel(flowId)
      hold.release(); await resumed
      expect(internals().checks.size).toBe(0)
      expect(existsSync(join(liveTask('fix').cwd, '.harness/loop/1.stdout.log'))).toBe(false)
    })
    it('fails the task when its check feedback cannot be delivered, and stops what it still owns', async () => {
      const g = gate('second')
      await startFlow(loopFlow(`[ -e "$HARNESS_PROJECT_DIR/first" ] && { ${g.run}; }; touch "$HARNESS_PROJECT_DIR/first"; exit 1`))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      turn('turn_started'); turn('turn_ended') // a steer turn starts the second check, which waits
      await vi.waitFor(() => expect(internals().checks.size).toBe(1))
      service.delivery({ deliveryId: checked().feedbackId!, sessionId: 'agent-1', state: 'rejected', reason: 'gone' })
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' }))
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      expect(cancelled).toContain('agent-1')
    })
    it('leaves a check that a daemon stop killed to the next start, which runs it again', async () => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().check?.pid).toEqual(expect.any(Number)))
      const pid = checked().check!.pid!
      service.stop() // kills the check at once and saves nothing over its loopState
      await vi.waitFor(() => expect(processGone(pid)).toBe(true))
      expect(onDisk().tasks[0].loopState).toMatchObject({ phase: 'checking', check: { pid } })
      const { run } = await restartOn()
      await vi.waitFor(() => expect(run().tasks[0].loopState).toMatchObject({ phase: 'checking', completed: 0 }))
      expect(run().tasks[0].loopState!.check!.pid).not.toBe(pid)
    })
    it('saves a check that could not be confirmed stopped as uncertain when the daemon stops before its fence', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await startFlow(loopFlow('x'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const check = lingeringStep()
      turn('turn_ended')
      let release!: () => void
      const owner = internals().exclusive(live(), liveTask('fix'), 1, () => new Promise<void>(r => { release = r })) // the fence waits for it
      await check.end()
      await vi.waitFor(() => expect([...internals().checks.values()][0]).toMatchObject({ uncertain: expect.any(String) }))
      service.stop()
      release(); await owner
      expect(onDisk().tasks[0]).toMatchObject({ state: 'blocked', uncertain: true, error: 'A loop check may still be running (pid 999999). Make sure it stopped before retrying.' })
    })
    it.each(['failed', 'cancelled'] as const)('decides by the check pid after a crash for a %s task whose check may still run', async state => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const left = orphan()
      const { next, run } = await restartOn(saved => {
        Object.assign(saved.tasks[0], { state, error: 'Timed out after 1h.', retryAt: Date.now() + 60_000, loopState: { phase: 'checking', completed: 0, turn: 1, check: { pid: left.pid, startedAt: Date.now() } } })
      })
      expect(run().tasks[0]).toMatchObject({ state: state === 'failed' ? 'blocked' : 'cancelled', uncertain: true, error: `A loop check may still be running (pid ${left.pid}). Make sure it stopped before retrying.` })
      expect(run().tasks[0].retryAt).toBeUndefined()
      expect(() => next.retry(flowId, 'fix')).toThrow(expect.objectContaining({ code: 'RETRY_UNSAFE', message: `This loop check may still be running from before the daemon restart (pid ${left.pid}). Stop that process, then retry.` }))
      process.kill(-left.pid, 'SIGKILL')
      await vi.waitFor(() => expect(processGone(left.pid)).toBe(true))
      next.retry(flowId, 'fix')
      expect(run().tasks[0].attempt).toBe(2)
    })
    it('leaves a failed task alone after a crash when its check is known to be gone', async () => {
      await startFlow(loopFlow('sleep 30'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      const ended = await exitedPid('true', []); await ended.exited
      const { run } = await restartOn(saved => {
        Object.assign(saved.tasks[0], { state: 'failed', error: 'Timed out after 1h.', loopState: { phase: 'checking', completed: 0, turn: 1, check: { pid: ended.pid, startedAt: Date.now() } } })
      })
      expect(run().tasks[0]).toMatchObject({ state: 'failed', uncertain: false, error: 'Timed out after 1h.' })
    })
    it('ends the attempt on resume when its feedback receipt failed while paused', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      live().state = 'paused'
      service.delivery({ deliveryId: checked().feedbackId!, sessionId: 'agent-1', state: 'rejected', reason: 'gone' })
      expect(liveTask('fix').state).toBe('running')
      await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
      expect(cancelled).toContain('agent-1')
    })
    it('ends the attempt after a restart when its feedback receipt failed before it was settled', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      const { run } = await restartOn(saved => { saved.messages.find(m => m.id === saved.tasks[0].loopState!.feedbackId)!.delivery = 'failed' })
      expect(run().tasks[0]).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
    })
    it('ends the attempt when its feedback receipt fails during the last phase of a reconcile', async () => {
      await startFlow(steps(
        { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
        { id: 'w', harness: 'test/cad', prompt: 'p', outputs: { files: ['out.txt'] } },
        { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
      ))
      await vi.waitFor(() => { for (const id of ['x', 'w', 'fix']) expect(liveTask(id).state).toBe('running') })
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).readVerdictSnapshot
      const gates: (() => void)[] = []
      const held = async (dir: string) => { await new Promise<void>(r => { gates.push(r) }); return actual(dir) }
      vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(held).mockImplementationOnce(held) // x's expiry, then w's result
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(gates).toHaveLength(1)) // step 4 holds on x
      writeFileSync(join(liveTask('w').cwd, 'out.txt'), 'x')
      service.ingest({ type: 'turn_ended', agentId: liveTask('w').agentId, payload: {} }) // kept: a reconcile runs
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      gates[0]()
      await vi.waitFor(() => expect(gates).toHaveLength(2)) // the last phase's drain holds on w: the receipt fails after any earlier scan
      service.delivery({ deliveryId: checked().feedbackId!, sessionId: liveTask('fix').agentId!, state: 'rejected', reason: 'gone' })
      gates[1](); await resumed
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
      expect(liveTask('w').state).toBe('succeeded')
    })
    it('applies a result that arrives while the last pass scans feedback receipts, before the barrier lifts', async () => {
      const g = gate('s')
      await startFlow(steps(
        { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
        { id: 's', run: g.run },
      ))
      await vi.waitFor(() => { expect(liveTask('fix').state).toBe('running'); expect(liveTask('s').state).toBe('running') })
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      live().state = 'paused'
      service.delivery({ deliveryId: checked().feedbackId!, sessionId: 'agent-1', state: 'rejected', reason: 'gone' }) // saved, left for the scan
      const hold = holdVerdictRead() // the scan's settlement of fix
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      g.open() // s exits while the scan is held: kept, because the barrier is up
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      hold.release(); await resumed
      expect(liveTask('fix').state).toBe('failed')
      expect(liveTask('s').state).toBe('succeeded') // another pass ran before the barrier lifted
      expect(internals().pending.size).toBe(0)
    })
    it('ends an attempt whose receipt fails after the scan passed it, before the barrier lifts', async () => {
      await startFlow(steps(
        { id: 'early', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
        { id: 'late', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
      ))
      await vi.waitFor(() => { expect(liveTask('early').state).toBe('running'); expect(liveTask('late').state).toBe('running') })
      for (const id of ['early', 'late']) service.ingest({ type: 'turn_ended', agentId: liveTask(id).agentId, payload: {} })
      await vi.waitFor(() => { for (const id of ['early', 'late']) expect(liveTask(id).loopState!.feedbackId).toBeDefined() })
      live().state = 'paused'
      const receipt = (id: string) => ({ deliveryId: liveTask(id).loopState!.feedbackId!, sessionId: liveTask(id).agentId!, state: 'rejected' as const, reason: 'gone' })
      service.delivery(receipt('late')) // the scan passes `early` (fine) and holds on `late`
      const hold = holdVerdictRead()
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      service.delivery(receipt('early')) // fails after the scan passed `early`
      hold.release(); await resumed
      expect(liveTask('late').state).toBe('failed')
      expect(liveTask('early')).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
    })
    it('ends the attempt on a lost feedback even when a later check result of that attempt waits to be applied', async () => {
      const g = gate('second')
      await startFlow(loopFlow(`[ -e "$HARNESS_PROJECT_DIR/first" ] && { ${g.run}; }; touch "$HARNESS_PROJECT_DIR/first"; exit 1`))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      const lost = checked().feedbackId!
      turn('turn_started'); turn('turn_ended') // the second check starts and waits
      await vi.waitFor(() => expect(internals().checks.size).toBe(1))
      live().state = 'paused'
      service.delivery({ deliveryId: lost, sessionId: 'agent-1', state: 'rejected', reason: 'gone' })
      g.open() // the second check fails below the limit while paused
      await vi.waitFor(() => expect(internals().checks.size).toBe(0))
      await service.resume(flowId)
      expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
      expect(checked()).toMatchObject({ completed: 1, feedbackId: lost }) // the second result never replaced the lost feedback
      expect(cancelled).toContain('agent-1')
      expect(sentTo('agent-1').some(text => text.includes('iteration 2 of 3'))).toBe(false)
    })
    it('starts no recovered check for an attempt whose feedback was lost', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      const { next, run } = await restartOn(saved => {
        saved.messages.find(m => m.id === saved.tasks[0].loopState!.feedbackId)!.delivery = 'failed'
        saved.tasks[0].loopState!.phase = 'check-requested'
      })
      expect(run().tasks[0]).toMatchObject({ state: 'failed', error: 'The check feedback could not be delivered. Log: .harness/loop/1.stderr.log' })
      expect((next as unknown as { checks: Map<string, unknown> }).checks.size).toBe(0)
      expect(existsSync(join(run().tasks[0].cwd, '.harness/loop/2.stdout.log'))).toBe(false)
    })
    it('leaves a check requested during the last phase to the timeout when the deadline passed meanwhile', async () => {
      await startFlow(steps(
        { id: 'x', harness: 'test/cad', prompt: 'p', timeout: '1h' },
        { id: 'w', harness: 'test/cad', prompt: 'p', outputs: { files: ['out.txt'] } },
        { id: 'fix', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
      ))
      await vi.waitFor(() => { for (const id of ['x', 'w', 'fix']) expect(liveTask(id).state).toBe('running') })
      live().state = 'paused'; liveTask('x').deadline = Date.now() - 1
      const actual = (await vi.importActual<typeof import('./outputs.js')>('./outputs.js')).readVerdictSnapshot
      const gates: (() => void)[] = []
      const held = async (dir: string) => { await new Promise<void>(r => { gates.push(r) }); return actual(dir) }
      vi.mocked(outputsModule.readVerdictSnapshot).mockImplementationOnce(held).mockImplementationOnce(held) // x's expiry, then w's result
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(gates).toHaveLength(1)) // step 4 holds on x
      writeFileSync(join(liveTask('w').cwd, 'out.txt'), 'x')
      service.ingest({ type: 'turn_ended', agentId: liveTask('w').agentId, payload: {} }) // kept: a reconcile runs
      await vi.waitFor(() => expect(internals().pending.size).toBe(1))
      gates[0]()
      await vi.waitFor(() => expect(gates).toHaveLength(2)) // the last phase's drain holds on w: step 5 has passed
      service.ingest({ type: 'turn_ended', agentId: liveTask('fix').agentId, payload: {} })
      liveTask('fix').deadline = Date.now() - 1
      clearTimeout(internals().deadlines.get(`${flowId}/fix/1`) as ReturnType<typeof setTimeout>); internals().deadlines.delete(`${flowId}/fix/1`) // its new deadline is armed when the barrier lifts
      const recovering = service.recover() // ready at once: the barrier's end arms deadlines (it joins the running reconcile)
      gates[1](); await resumed; await recovering
      expect(internals().checks.size).toBe(0)
      await vi.waitFor(() => expect(liveTask('fix')).toMatchObject({ state: 'failed', error: 'Timed out after 1h.' }))
      expect(existsSync(join(liveTask('fix').cwd, '.harness/loop/1.stdout.log'))).toBe(false)
    })
    it('stops ending attempts with lost feedback once the run was cancelled during the scan', async () => {
      await startFlow(steps(
        { id: 'early', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
        { id: 'late', harness: 'test/cad', prompt: 'fix', loop: { until_run: 'exit 1', max_iterations: 3 }, timeout: '1h' },
      ))
      await vi.waitFor(() => { expect(liveTask('early').state).toBe('running'); expect(liveTask('late').state).toBe('running') })
      for (const id of ['early', 'late']) service.ingest({ type: 'turn_ended', agentId: liveTask(id).agentId, payload: {} })
      await vi.waitFor(() => { for (const id of ['early', 'late']) expect(liveTask(id).loopState!.feedbackId).toBeDefined() })
      live().state = 'paused'
      for (const id of ['early', 'late']) service.delivery({ deliveryId: liveTask(id).loopState!.feedbackId!, sessionId: liveTask(id).agentId!, state: 'rejected', reason: 'gone' })
      const hold = holdVerdictRead() // the scan holds on `early`
      const resumed = service.resume(flowId)
      await vi.waitFor(() => expect(hold.reading()).toBe(true))
      service.cancel(flowId)
      hold.release(); await resumed
      for (const id of ['early', 'late']) expect(liveTask(id)).toMatchObject({ state: 'cancelled', error: null })
    })
    it('leaves a failed loop task alone after a restart when its last check ended it', async () => {
      await startFlow(loopFlow('exit 1', 1))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('failed'))
      expect(checked().phase).toBe('checking')
      expect(checked().check).toBeUndefined()
      const { run } = await restartOn()
      expect(run().tasks[0]).toMatchObject({ state: 'failed', uncertain: false, error: expect.stringMatching(/^Check still failing after 1 iteration/) })
    })
    it('leaves a loop task working when its feedback receipt is unknown after a restart, and resends nothing', async () => {
      await startFlow(loopFlow('exit 1'))
      await vi.waitFor(() => expect(liveTask('fix').state).toBe('running'))
      turn('turn_ended')
      await vi.waitFor(() => expect(checked().feedbackId).toBeDefined())
      const sendsBefore = sends.length
      const { run } = await restartOn(saved => { saved.messages.find(m => m.id === saved.tasks[0].loopState!.feedbackId)!.delivery = 'accepted' }) // load turns it into unknown
      expect(run().tasks[0]).toMatchObject({ state: 'running', loopState: { phase: 'working', completed: 1 } })
      expect(run().messages.find(m => m.id === run().tasks[0].loopState!.feedbackId)!.delivery).toBe('unknown')
      expect(sends.length).toBe(sendsBefore)
    })
  })
})
