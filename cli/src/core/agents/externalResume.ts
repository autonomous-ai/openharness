/** Durable external adoption. Search may hold an intent, but never owns its lifecycle or pane. */
import { randomUUID } from 'node:crypto'
import type { BackendSocket } from '../../backendSocket.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { externalSessionRequest, externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../../lib/externalSessionWire.js'
import { externalReservations, externalResumeIds, externalResumePending, type ExternalResumeIntent } from '../../lib/externalResume.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TmuxBackend } from '../../lib/tmuxBackend.js'
import { adoptionDecision } from './adopt.js'
import { heldPaneArgv } from './heldLaunches.js'
import { createExternalInspector } from './externalInspect.js'
import { stopExternalOwner } from './externalOwner.js'

type CreateAgent = NonNullable<BackendSocket['onCreateAgent']>
type Owner = NonNullable<ExternalResumeIntent['owner']>
const sameOwner = (a: Owner, b: Owner) => JSON.stringify(a) === JSON.stringify(b)
const activityUnknown = (answer: ExternalSessionAnswer) => answer.ok && answer.owner && answer.busy && !answer.busyConfirmed
const ACTIVITY_UNKNOWN = 'Waiting to verify whether this conversation is idle in its terminal. Close it there to continue.'
const identity = (row: RegisteredSession | undefined) => row && JSON.stringify([
  row.engine, row.registeredAt, row.sessionId, row.launch, row.processIdentity, row.cwd, row.codexHome, row.permissionMode, row.bypassPermission, row.runtimes.map(terminalRouteKey).sort(), row.externalResume,
])

export interface ExternalResumeDeps {
  registry: Pick<typeof registry, 'byAgent' | 'list' | 'openPendingAgent' | 'externalConflict' | 'setExternalResume' | 'setLaunch' | 'finishExternalCancellation'>
  tmux: Pick<TmuxBackend, 'create' | 'killHeld'> | null
  inspect(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
  waiting(row: RegisteredSession): Promise<boolean>
  generation(): unknown
  stopped(): readonly Pick<RegisteredSession, 'sessionId' | 'externalResume'>[]
  cancelled(agentId: string): boolean
  preflight(row: RegisteredSession, session: NonNullable<ExternalResumeIntent['session']>): Promise<{ detail: string } | null>
  announce(row: RegisteredSession): void
  launch(): void
  forget(agentId: string): void
  stopOwner?: typeof stopExternalOwner
}

export function createExternalResumes(deps: ExternalResumeDeps) {
  let stopped = false, opened = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const running = new Map<string, Promise<void>>()
  const due = new Map<string, number>()
  const held = (id: string, except?: string) => !!deps.registry.externalConflict([id], except) || deps.stopped().some(row => externalReservations(row).includes(id))
  const inspect = createExternalInspector({ call: deps.inspect, generation: deps.generation })
  const occupied = (row: RegisteredSession) => externalResumeIds(row.externalResume).some(id => held(id, row.agentId))
  const hold = (row: RegisteredSession, detail: string) => {
    if (row.launch?.state === 'held' && row.launch.detail === detail) return
    const changed = deps.registry.setLaunch(row.agentId, { state: 'held', service: 'search', detail })
    if (changed) deps.announce(changed)
  }
  const advance = async (initial: RegisteredSession) => {
    let row = initial
    const current = () => !stopped && !deps.cancelled(row.agentId) && !occupied(row)
      && identity(deps.registry.byAgent(row.agentId)) === identity(row)
    const commit = (intent: ExternalResumeIntent) => {
      if (!current()) return false
      const changed = deps.registry.setExternalResume(row.agentId, intent)
      if (!changed) return false
      row = { ...changed }
      return true
    }
    const intent = row.externalResume!
    if (intent.phase === 'cancelled') { await cancel(row, () => !stopped); return }
    if (occupied(row)) { hold(row, 'This conversation is already open or saved in another harness.'); return }
    if (!current() || row.launch?.state !== 'held' || row.processIdentity) return
    if (!await deps.waiting(row) || !current()) { if (current()) hold(row, 'Waiting to verify this adoption’s terminal pane.'); return }
    let answer = await inspect(intent.request)
    if (!current()) return
    if (!answer.ok) { hold(row, answer.detail); return }
    const decision = adoptionDecision(intent.request.sessionId, intent.request.engine, intent.takeOver, answer, id => held(id, row.agentId))
    if (!decision.ok) { hold(row, decision.error === 'SESSION_BUSY_IN_TERMINAL' && activityUnknown(answer) ? ACTIVITY_UNKNOWN : decision.detail); return }
    const session = answer.session!
    const owner: Owner | undefined = answer.owner && answer.generation ? { process: answer.owner, generation: answer.generation } : undefined
    if (intent.session && owner && (!intent.owner || !sameOwner(intent.owner, owner))) {
      hold(row, 'The conversation moved to another process. Close it there, then open it here again.'); return
    }
    if (!commit({ ...intent, session, ...(owner ? { owner } : {}) })) return
    if (owner && decision.busy && intent.takeOver === 'wait') { hold(row, activityUnknown(answer) ? ACTIVITY_UNKNOWN : 'Waiting for the conversation’s current turn to finish in its terminal.'); return }
    const refusal = await deps.preflight(row, session)
    if (!current()) return
    if (refusal) { hold(row, refusal.detail); return }
    if (owner) {
      // Journal the exact target before a signal. A crash or a later process cannot inherit consent.
      if (!commit({ ...row.externalResume!, phase: 'quitting', owner })) return
      let interrupted = false
      const same = async () => {
        // The pane probe can wait on tmux. Take the decisive owner/turn evidence after it.
        if (!await deps.waiting(row) || !current()) return false
        answer = await inspect(intent.request)
        if (!current() || !answer.ok || !answer.session) return false
        const fresh = adoptionDecision(intent.request.sessionId, intent.request.engine, intent.takeOver, answer, id => held(id, row.agentId))
        interrupted = answer.busyConfirmed === true
        return fresh.ok && answer.session.sessionId === session.sessionId && answer.session.cwd === session.cwd
          && answer.session.transcriptPath === session.transcriptPath
          && JSON.stringify(answer.session.launchArgs) === JSON.stringify(session.launchArgs)
          && !!answer.owner && !!answer.generation && sameOwner(owner, { process: answer.owner, generation: answer.generation })
          && (intent.takeOver === 'now' || !answer.busy)
      }
      if (!await (deps.stopOwner ?? stopExternalOwner)(owner, { current, same,
        beforeSignal: signal => {
          // KILL needs the same locked conflict check after TERM's grace period, even when the
          // durable intent is unchanged. A daemon-down hook can bind another owner meanwhile.
          const next = signal === 'SIGTERM' ? { ...row.externalResume!, signal: 'prepared' as const, continue: interrupted ? true as const : undefined } : row.externalResume!
          if (!commit(next)) throw new Error('Signal intent could not be saved')
        },
        afterSignal: signal => {
          if (signal === 'SIGTERM' && !commit({ ...row.externalResume!, signal: 'sent' })) throw new Error('Signal receipt could not be saved')
        },
      })) {
        if (current()) hold(row, 'Waiting to confirm the original terminal stopped. Close it there to continue.'); return
      }
      if (!current()) return
    }
    if (!await deps.waiting(row) || !current()) {
      if (current()) hold(row, 'Waiting to verify this adoption’s terminal pane.')
      return
    }
    // Neither an exited PID nor an earlier free answer proves this conversation is still free.
    // No asynchronous work may separate this final read from the durable admission.
    answer = await inspect(intent.request)
    if (!current()) return
    const final = adoptionDecision(intent.request.sessionId, intent.request.engine, intent.takeOver, answer, id => held(id, row.agentId))
    if (!final.ok) { hold(row, final.detail); return }
    if (!answer.ok || !answer.session || answer.owner || answer.session.sessionId !== session.sessionId
      || answer.session.cwd !== session.cwd || answer.session.transcriptPath !== session.transcriptPath
      || JSON.stringify(answer.session.launchArgs) !== JSON.stringify(session.launchArgs)) {
      hold(row, 'The conversation changed while preparing to open it. Waiting to verify it again.'); return
    }
    if (!commit({ ...row.externalResume!, phase: 'admitted', session: answer.session })) return
    deps.announce(row)
    deps.launch()
  }
  const wake = () => {
    if (stopped || !opened) return
    if (timer) { clearTimeout(timer); timer = undefined }
    const pending = deps.registry.list().filter(row => externalResumePending(row.externalResume)).sort((a, b) => (due.get(a.agentId) ?? 0) - (due.get(b.agentId) ?? 0))
    for (const id of due.keys()) if (!pending.some(row => row.agentId === id)) due.delete(id)
    for (const entry of pending) {
      if (running.size >= 4) break
      if (running.has(entry.agentId) || (due.get(entry.agentId) ?? 0) > Date.now() || deps.cancelled(entry.agentId)) continue
      due.set(entry.agentId, Date.now() + 2_000)
      const task = advance({ ...entry }).catch(() => {
        const row = deps.registry.byAgent(entry.agentId)
        if (!stopped && !deps.cancelled(entry.agentId) && row?.externalResume && row.externalResume.token === entry.externalResume?.token && externalResumePending(row.externalResume)
          && row.externalResume.phase !== 'cancelled') hold(row, 'Waiting for a durable adoption record. No new process has been started.')
      }).finally(() => { running.delete(entry.agentId); if (!stopped) schedule() })
      running.set(entry.agentId, task)
    }
    if (pending.length) schedule()
  }
  const schedule = () => { if (!timer && !stopped) { timer = setTimeout(() => { timer = undefined; wake() }, 2_000); timer.unref() } }
  const create: CreateAgent = async input => {
    if (stopped || !opened) return { ok: false, error: 'CORE_NOT_READY' }
    if (!deps.tmux) return { ok: false, error: 'TMUX_UNAVAILABLE' }
    const request = externalSessionRequest({ sessionId: input.resumeSessionId, engine: input.engine })
    if (!request) return { ok: false, error: 'INVALID_SESSION' }
    const answer = await inspect(request)
    if (stopped) return { ok: false, error: 'CORE_NOT_READY' }
    const decision = adoptionDecision(request.sessionId, request.engine, input.takeOver ?? null, answer, held)
    if (!decision.ok && decision.error !== 'SEARCH_UNAVAILABLE'
      && !(decision.error === 'SESSION_BUSY_IN_TERMINAL' && activityUnknown(answer))) return decision
    const intent: ExternalResumeIntent = { token: randomUUID(), request, takeOver: input.takeOver ?? null, phase: 'waiting',
      ...(answer.ok && answer.session ? { session: answer.session } : {}),
      ...(answer.ok && answer.owner && answer.generation ? { owner: { process: answer.owner, generation: answer.generation } } : {}) }
    const result = await createAndRegisterPane({
      tmuxBackend: { create: req => deps.tmux!.create({ ...req, current: () => !stopped }), kill: runtime => deps.tmux!.killHeld(runtime, intent.token, () => true) },
      registry: deps.registry, engine: input.engine, sessionLabel: buildHarnessSessionLabel(input.engine),
      argv: heldPaneArgv(externalUnavailable().detail, intent.token), cwd: null, externalResume: intent,
      codexHome: input.codexHome, bypassPermission: input.bypassPermission, permissionMode: input.permissionMode,
      defaultName: input.name ?? (answer.ok ? answer.session?.title : undefined),
    })
    if (!result.ok) return result
    deps.announce(result.pending)
    wake()
    return { ok: true, session: result.pending }
  }
  const cancel = async (initial: RegisteredSession, allowed: () => boolean = () => true) => {
    if (!externalResumePending(initial.externalResume)) return false
    const target = identity(initial)
    const current = () => allowed() && identity(deps.registry.byAgent(initial.agentId)) === target
    if (!current()) throw new Error('The adoption changed before cancellation.')
    const cancelled = deps.registry.setExternalResume(initial.agentId, { ...initial.externalResume!, phase: 'cancelled' })
    if (!cancelled) throw new Error('The adoption cancellation could not be saved.')
    const saved = identity(cancelled)
    const owns = () => allowed() && identity(deps.registry.byAgent(initial.agentId)) === saved
    const panes = cancelled.runtimes.filter(runtime => runtime.backend === 'tmux')
    if (!deps.tmux || !panes.length) throw new Error('The waiting pane could not be verified.')
    for (const pane of panes) {
      const result = await deps.tmux.killHeld(pane, cancelled.externalResume!.token, owns)
      if (!owns() || result.state !== 'succeeded') throw new Error('The waiting pane could not be verified. Adoption stays cancelled.')
    }
    if (!deps.registry.finishExternalCancellation(initial.agentId)) throw new Error('The cancellation could not be committed.')
    deps.forget(initial.agentId)
    return true
  }
  return { create, cancel, wake, open: () => { opened = true; wake() }, stop: () => { stopped = true; if (timer) clearTimeout(timer) },
    settled: async () => { await Promise.all(running.values()) } }
}
