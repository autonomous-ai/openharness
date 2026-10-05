import { describe, expect, it, vi } from 'vitest'
import { orchestratorRequest } from './wire.js'
import { OrchestratorError } from './model.js'
import type { OrchestratorService } from './service.js'

const id = 'a'.repeat(32), messageId = 'b'.repeat(32)
const makeService = () => {
  const service = Object.fromEntries(['list', 'catalog', 'start', 'snapshot', 'plan', 'finish', 'retry', 'cancel', 'resume', 'complete', 'chat', 'steer', 'answer', 'reconciled'].map(key => [key, vi.fn(() => ({ id }))]))
  service.reconciled.mockImplementation((() => Promise.resolve()) as never)
  return service
}
describe('orchestrator RPC boundary', () => {
  it.each(['list', 'catalog', 'start'])('returns %s data under the stable wire key', async action => {
    const service = makeService()
    expect(await orchestratorRequest(service as unknown as OrchestratorService, { action, id })).toEqual({ [action === 'list' ? 'projects' : action === 'catalog' ? 'harnesses' : 'project']: { id } })
    expect(service[action]).toHaveBeenCalledTimes(1)
    expect(service.snapshot).not.toHaveBeenCalled()
  })
  it.each([
    ['status', 'snapshot', [id]],
    ['plan', 'plan', [id, []]],
    ['finish', 'finish', [id, 'task', 1, 'verified', ['file.step'], false]],
    ['fail', 'finish', [id, 'task', 1, 'verified', [], true]],
    ['retry', 'retry', [id, 'task']], ['cancel', 'cancel', [id, 'task']],
    ['resume', 'resume', [id]], ['complete', 'complete', [id, 'verified']],
    ['message', 'chat', [id, messageId, 'hello']],
    ['steer', 'steer', [id, 'task', 1, messageId, 'hello']],
  ])('validates and dispatches %s', async (action, method, args) => {
    const service = makeService()
    const reply = await orchestratorRequest(service as unknown as OrchestratorService, { action, id, tasks: [], taskId: 'task', attempt: 1, summary: 'verified', ...(action === 'finish' ? { artifacts: ['file.step'] } : {}), messageId, text: 'hello' })
    expect(reply).toEqual({ project: { id } })
    expect(service[method as string]).toHaveBeenCalledWith(...args as unknown[])
  })
  it('tells a loop worker that its finish was recorded for the check', async () => {
    const service = makeService()
    service.finish.mockImplementation((async () => 'recorded') as never)
    expect(await orchestratorRequest(service as unknown as OrchestratorService, { action: 'finish', id, taskId: 'task', attempt: 1, summary: 'did it' })).toEqual({ project: { id }, notice: 'Recorded. The check runs when this turn ends.' })
  })
  it('routes approve and reject with their attempt, strictly', async () => {
    const service = makeService()
    const wire = (payload: Record<string, unknown>) => orchestratorRequest(service as unknown as OrchestratorService, payload)
    expect(await wire({ action: 'approve', id, taskId: 'ok', attempt: 2, decision: 'ship', comment: 'yes', requestId: 'r' })).toEqual({ project: { id } })
    await wire({ action: 'reject', id, taskId: 'ok', attempt: 2 })
    expect(service.answer.mock.calls).toEqual([
      [id, 'ok', 2, { outcome: 'approved', decision: 'ship', comment: 'yes' }],
      [id, 'ok', 2, { outcome: 'rejected', decision: undefined, comment: undefined }],
    ])
    for (const bad of [{ attempt: 0 }, { attempt: 1, extra: 1 }, { attempt: 1, decision: 'ship' }, { attempt: 1, comment: 'x'.repeat(4001) }]) {
      expect(await wire({ action: 'reject', id, taskId: 'ok', ...bad })).toMatchObject({ error: 'INVALID_REQUEST' })
    }
    expect(service.answer).toHaveBeenCalledTimes(2)
  })
  it('answers resume only once the service has finished resuming', async () => {
    const service = makeService()
    let release!: () => void
    service.resume.mockImplementation((() => new Promise<void>(r => { release = r })) as never)
    let answered = false
    const reply = orchestratorRequest(service as unknown as OrchestratorService, { action: 'resume', id }).then(r => { answered = true; return r })
    await vi.waitFor(() => expect(service.resume).toHaveBeenCalled())
    expect(answered).toBe(false)
    release()
    expect(await reply).toEqual({ project: { id } })
  })
  it('waits for a reconcile to end before a mutating action, but not for cancel or status', async () => {
    const service = makeService()
    let release!: () => void
    service.reconciled.mockImplementation((() => new Promise<void>(r => { release = r })) as never)
    const retried = orchestratorRequest(service as unknown as OrchestratorService, { action: 'retry', id, taskId: 'task' })
    const others = [orchestratorRequest(service as unknown as OrchestratorService, { action: 'cancel', id }), orchestratorRequest(service as unknown as OrchestratorService, { action: 'status', id })]
    await vi.waitFor(() => { expect(service.cancel).toHaveBeenCalled(); expect(service.snapshot).toHaveBeenCalledTimes(2) }) // answered without waiting
    expect(service.retry).not.toHaveBeenCalled()
    release(); await Promise.all([retried, ...others])
    expect(service.retry).toHaveBeenCalledWith(id, 'task')
  })
  it('supports whole-project cancellation and reports validation errors without dispatch', async () => {
    const service = makeService(), wire = (payload: Record<string, unknown>) => orchestratorRequest(service as unknown as OrchestratorService, payload)
    await wire({ action: 'cancel', id }); expect(service.cancel).toHaveBeenCalledWith(id, undefined)
    for (const payload of [{ action: 'start' }, { action: 'finish', attempt: 0 }, { action: 'steer', attempt: 1, messageId: 'bad' }]) {
      if (payload.action === 'start') continue // the service validates the creation spec
      expect(await wire({ id, taskId: 'task', summary: 'verified', ...payload })).toMatchObject({ error: 'INVALID_REQUEST' })
    }
    expect(service.finish).not.toHaveBeenCalled(); expect(service.steer).not.toHaveBeenCalled()
  })
  it.each([
    [new OrchestratorError('KNOWN_ERROR', 'Actionable detail'), 'KNOWN_ERROR', 'Actionable detail'],
    [new Error('Disk full'), 'ORCHESTRATOR_FAILED', 'Disk full'],
    ['untyped failure', 'ORCHESTRATOR_FAILED', 'Orchestration request failed.'],
  ])('normalizes failures without losing known codes', async (failure, code, detail) => {
    const service = makeService(); service.list.mockImplementation(() => { throw failure })
    expect(await orchestratorRequest(service as unknown as OrchestratorService, { action: 'list' })).toEqual({ error: code, detail })
  })
})
