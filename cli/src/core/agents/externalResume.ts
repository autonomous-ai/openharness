/** Durable external adoption. Search may hold an intent, but never owns its lifecycle or pane. */
import { randomUUID } from 'node:crypto'
import type { BackendSocket } from '../../backendSocket.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { externalSessionRequest, externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../../lib/externalSessionWire.js'
import { externalReservations, externalResumeIds, externalResumePending, type ExternalResumeIntent } from '../../lib/externalResume.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import { adoptionDecision } from './adopt.js'
import { heldPaneArgv } from './heldLaunches.js'
import { createExternalInspector } from './externalInspect.js'
import { stopExternalOwner } from './externalOwner.js'
import { moveHeldLine } from '../../lib/hostMove/moveAgent.js'

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
  /** The backend an adoption's waiting pane opens on (the one new panes are made on); null when there is none.
   *  One that cannot close a held pane by its token (`killHeld`) opens none. */
  backend: Pick<TerminalBackend, 'create' | 'killHeld'> | null
  /** What an adoption answers when [backend] is null: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
  /** Each runtime's own backend: a cancelled adoption's waiting pane is closed by the one it is on. */
  backendFor: (runtime: TerminalRuntimeRef) => Pick<TerminalBackend, 'killHeld'> | undefined
  inspect(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
  waiting(row: RegisteredSession): Promise<boolean>
  generation(): unknown
  stopped(): readonly Pick<RegisteredSession, 'sessionId' | 'externalResume'>[]
  cancelled(agentId: string): boolean
  preflight(row: RegisteredSession, session: NonNullable<ExternalResumeIntent['session']>, current?: () => boolean): Promise<{ detail: string } | { current(): boolean } | null>
  announce(row: RegisteredSession): void
  launch(): void
  forget(agentId: string): void
  stopOwner?: typeof stopExternalOwner
  /** The agent whose conversation [sessionId] is, when a move a dead daemon left may still run its engine (main.ts
   *  `moveHeld`): adopted, it would get a second engine beside that one. Null for any other. */
  heldConversation?: (sessionId: string) => string | null
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
    const refusal = await deps.preflight(row, session, current)
    if (!current()) return
    if (refusal && 'detail' in refusal) { hold(row, refusal.detail); return }
    const nativeCurrent = () => !refusal || refusal.current()
    if (!nativeCurrent()) { hold(row, 'Waiting to confirm the prepared native launch.'); return }
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
        return nativeCurrent() && fresh.ok && answer.session.sessionId === session.sessionId && answer.session.cwd === session.cwd
          && answer.session.transcriptPath === session.transcriptPath
          && JSON.stringify(answer.session.launchArgs) === JSON.stringify(session.launchArgs)
          && !!answer.owner && !!answer.generation && sameOwner(owner, { process: answer.owner, generation: answer.generation })
          && (intent.takeOver === 'now' || !answer.busy)
      }
      if (!await (deps.stopOwner ?? stopExternalOwner)(owner, { current: () => current() && nativeCurrent(), same,
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
    if (!nativeCurrent()) { hold(row, 'Waiting to confirm the prepared native launch is still current.'); return }
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
    const backend = deps.backend
    if (!backend?.killHeld) return { ok: false, error: backend ? 'TMUX_UNAVAILABLE' : deps.noBackendCode ?? 'TMUX_UNAVAILABLE' }
    const request = externalSessionRequest({ sessionId: input.resumeSessionId, engine: input.engine })
    if (!request) return { ok: false, error: 'INVALID_SESSION' }
    const moveHeld = (ids: readonly string[]) => {
      const agentId = ids.map((id) => deps.heldConversation?.(id) ?? null).find((held) => held !== null)
      if (!agentId) return null
      console.warn(moveHeldLine(agentId))
      return { ok: false as const, error: 'AGENT_BUSY', detail: 'This conversation is held until the daemon restarts.' }
    }
    const heldBefore = moveHeld([request.sessionId])
    if (heldBefore) return heldBefore
    const answer = await inspect(request)
    if (stopped) return { ok: false, error: 'CORE_NOT_READY' }
    const heldAfter = answer.ok && answer.session ? moveHeld([answer.session.sessionId, ...answer.session.aliases ?? []]) : null
    if (heldAfter) return heldAfter
    const decision = adoptionDecision(request.sessionId, request.engine, input.takeOver ?? null, answer, held)
    if (!decision.ok && decision.error !== 'SEARCH_UNAVAILABLE'
      && !(decision.error === 'SESSION_BUSY_IN_TERMINAL' && activityUnknown(answer))) return decision
    const intent: ExternalResumeIntent = { token: randomUUID(), request, takeOver: input.takeOver ?? null, phase: 'waiting',
      ...(answer.ok && answer.session ? { session: answer.session } : {}),
      ...(answer.ok && answer.owner && answer.generation ? { owner: { process: answer.owner, generation: answer.generation } } : {}) }
    const result = await createAndRegisterPane({
      tmuxBackend: { create: req => backend.create({ ...req, current: () => !stopped }), kill: runtime => backend.killHeld!(runtime, intent.token, () => true) },
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
    // Every pane, each on its own backend, which must be able to close it by its token: checked before any closes.
    const panes = cancelled.runtimes.map(runtime => ({ runtime, backend: deps.backendFor(runtime) }))
    if (!panes.length || panes.some(pane => !pane.backend?.killHeld)) throw new Error('The waiting pane could not be verified.')
    for (const { runtime, backend } of panes) {
      const result = await backend!.killHeld!(runtime, cancelled.externalResume!.token, owns)
      if (!owns() || result.state !== 'succeeded') throw new Error('The waiting pane could not be verified. Adoption stays cancelled.')
    }
    if (!deps.registry.finishExternalCancellation(initial.agentId)) throw new Error('The cancellation could not be committed.')
    deps.forget(initial.agentId)
    return true
  }
  return { create, cancel, wake, open: () => { opened = true; wake() }, stop: () => { stopped = true; if (timer) clearTimeout(timer) },
    settled: async () => { await Promise.all(running.values()) } }
}
