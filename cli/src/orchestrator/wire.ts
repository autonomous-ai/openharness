import { z } from 'zod'
import { DecisionId, OrchestratorError, RunId, TaskId } from './model.js'
import type { OrchestratorService } from './service.js'

// Actions that change a run wait for its reconcile to end; cancel fences at once and status only reads.
const MUTATING = new Set(['plan', 'finish', 'fail', 'retry', 'steer', 'approve', 'reject'])

const Answer = z.strictObject({
  action: z.enum(['approve', 'reject']), id: RunId, requestId: z.string().optional(),
  taskId: TaskId, attempt: z.number().int().min(1),
  decision: DecisionId.optional(), comment: z.string().max(4000).optional(),
}).refine(a => a.action === 'approve' || a.decision === undefined, { message: 'reject takes no decision', path: ['decision'] })

export async function orchestratorRequest(service: OrchestratorService, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const action = z.enum(['list', 'catalog', 'start', 'status', 'plan', 'finish', 'fail', 'retry', 'cancel', 'resume', 'complete', 'message', 'steer', 'approve', 'reject']).parse(payload.action)
    if (action === 'list') return { projects: service.list() }
    if (action === 'catalog') return { harnesses: service.catalog() }
    if (action === 'start') return { project: await service.start(payload) }
    const id = RunId.parse(payload.id)
    if (MUTATING.has(action)) await service.reconciled(id)
    let recorded: 'recorded' | undefined
    switch (action) {
      case 'plan': service.plan(id, payload.tasks); break
      case 'finish':
      case 'fail':
        recorded = await service.finish(id, TaskId.parse(payload.taskId), z.number().int().min(1).parse(payload.attempt),
          z.string().parse(payload.summary), z.array(z.string()).parse(payload.artifacts ?? []), action === 'fail')
        break
      case 'retry': service.retry(id, TaskId.parse(payload.taskId)); break
      case 'cancel': service.cancel(id, payload.taskId === undefined ? undefined : TaskId.parse(payload.taskId)); break
      case 'resume': await service.resume(id); break
      case 'complete': service.complete(id, z.string().parse(payload.summary)); break
      case 'message': service.chat(id, RunId.parse(payload.messageId), z.string().parse(payload.text)); break
      case 'steer': service.steer(id, TaskId.parse(payload.taskId), z.number().int().min(1).parse(payload.attempt), RunId.parse(payload.messageId), z.string().parse(payload.text)); break
      case 'approve':
      case 'reject': {
        const a = Answer.parse(payload)
        await service.answer(id, a.taskId, a.attempt, { outcome: a.action === 'approve' ? 'approved' : 'rejected', decision: a.decision, comment: a.comment })
        break
      }
    }
    // A loop task's finish is only recorded: its check decides when the turn ends.
    return { project: service.snapshot(id), ...(recorded === 'recorded' ? { notice: 'Recorded. The check runs when this turn ends.' } : {}) }
  } catch (error) {
    return {
      error: error instanceof OrchestratorError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'ORCHESTRATOR_FAILED',
      detail: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ')
        : error instanceof Error ? error.message : 'Orchestration request failed.',
    }
  }
}
