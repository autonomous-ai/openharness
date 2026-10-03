import { randomUUID } from 'node:crypto'
import type { SelectionFocus } from './windowSelection.js'

export interface VisitCommand {
  op: 'open' | 'latest' | 'back' | 'cancel'
  visitId: string
  agentId?: string
  machineId?: string
}
export interface VisitResult { ok: boolean; active: boolean; agentId?: string; label?: string; error?: string; note?: string }
interface Visit { id: string; connId: string; machineId: string; agentId: string; label: string }
interface Pending {
  visit: Visit; requestId: string; agentId: string
  resolve: (result: VisitResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** One attention detour in the window at this desk. Keep the original socket
 * when the visit crosses machines; never broadcast navigation to other Macs. */
export class WindowVisit {
  private visit?: Visit
  private pending?: Pending
  constructor(private readonly wiring: {
    focus: () => SelectionFocus | undefined
    send: (connId: string, payload: Record<string, unknown>) => boolean
    timeoutMs?: number
  }) {}

  async command(command: VisitCommand): Promise<VisitResult> {
    const fail = (error: string): VisitResult => ({ ok: false, active: false, error })
    if (!/^[a-zA-Z0-9-]{1,48}$/.test(command.visitId)) return fail('Invalid visit identity.')
    if (command.op === 'cancel') {
      if (this.visit?.id === command.visitId) this.cancel()
      return { ok: true, active: false }
    }
    if (this.pending) return { ok: false, active: !!this.visit?.label, label: this.visit?.label, error: 'Wait for the app.' }
    const focus = this.wiring.focus()
    const opening = command.op === 'open' || command.op === 'latest'
    if (opening) {
      if (!focus || !command.agentId || !command.machineId) return fail('Select a terminal pane in Harness first.')
      if (command.op === 'latest' && (command.agentId !== focus.agentId || command.machineId !== focus.machineId)) {
        const active = this.visit?.id === command.visitId && !!this.visit.label
        return { ok: false, active, ...(active ? { label: this.visit!.label } : {}), error: 'The pane changed. Choose Latest output again.' }
      }
      if (this.visit?.id !== command.visitId) {
        this.cancel()
        this.visit = { id: command.visitId, connId: focus.connId, machineId: focus.machineId, agentId: focus.agentId, label: '' }
      }
    }
    const visit = this.visit
    if (!visit || visit.id !== command.visitId) return fail('The previous visit has ended.')
    const requestId = randomUUID()
    const timeout = this.wiring.timeoutMs ?? 2000
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return
        this.finish(fail('The app did not answer. Reopen Harness.'))
        this.cancel()
      }, timeout)
      this.pending = { visit, requestId, timer, resolve, agentId: opening ? command.agentId! : visit.agentId }
      if (!this.wiring.send(visit.connId, {
        requestId, visitId: visit.id, op: command.op, expiresAt: Date.now() + timeout,
        ...(opening ? {
          fromMachineId: focus!.machineId, fromAgentId: focus!.agentId,
          machineId: command.machineId, agentId: command.agentId,
        } : {}),
      })) {
        this.finish(fail('Open Harness on this computer.'))
        this.cancel()
      }
    })
  }

  reply(connId: string, machineId: string, payload: Record<string, unknown>): void {
    const p = this.pending
    if (!p || p.visit.connId !== connId || p.visit.machineId !== machineId ||
        p.visit.id !== payload.visitId || p.requestId !== payload.requestId) return
    if (typeof payload.ok !== 'boolean' || typeof payload.active !== 'boolean' ||
        (payload.ok && payload.agentId !== p.agentId) ||
        (payload.active && payload.ok && (typeof payload.label !== 'string' || payload.label.length > 192))) {
      this.finish({ ok: false, active: false, error: 'The app returned an invalid visit.' })
      this.cancel()
      return
    }
    if (typeof payload.label === 'string') p.visit.label = payload.label.slice(0, 192)
    const active = payload.active
    this.finish({ ok: payload.ok, active,
      ...(payload.ok ? { agentId: p.agentId } : {}),
      ...(active ? { label: p.visit.label } : {}),
      ...(typeof payload.error === 'string' ? { error: payload.error.slice(0, 180) } : {}),
      ...(typeof payload.note === 'string' ? { note: payload.note.slice(0, 180) } : {}),
    })
    if (!active) this.cancel()
  }

  cancel(): void {
    const visit = this.visit
    this.visit = undefined
    this.finish({ ok: false, active: false, error: 'Visit closed.' })
    if (visit) this.wiring.send(visit.connId, {
      requestId: randomUUID(), visitId: visit.id, op: 'cancel',
    })
  }

  private finish(result: VisitResult): void {
    const p = this.pending
    this.pending = undefined
    if (!p) return
    clearTimeout(p.timer)
    p.resolve(result)
  }
}
