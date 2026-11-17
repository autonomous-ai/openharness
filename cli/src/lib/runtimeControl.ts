import type { ModelControlFor } from './modelControl.js'
import { RuntimeProfileControlError } from '../engines/facets/modelControl.js'
export { RuntimeProfileControlError, type RuntimeProfileErrorCode } from '../engines/facets/modelControl.js'
import type { ScreenReader } from './screenReader.js'
export type { PaneInspection, PaneTakeover } from '../engines/facets/screen.js'
import { parseRuntimeProfile } from './runtimeProfileWire.js'
import type { RegisteredSession } from './registry.js'
import type { RuntimeProfileManager } from './runtimeProfile.js'

export interface RuntimeProfileControllerDeps {
  modelControlFor: ModelControlFor
  readScreen: ScreenReader
  manager: Pick<RuntimeProfileManager, 'getState' | 'selectedModel' | 'codexCatalog' | 'modelsForSession'
    | 'beginControl' | 'finishControl' | 'cancelControl' | 'confirmEffort' | 'waitForProfile' | 'waitForModel'
    | 'ingestConfig' | 'confirmControlProfile'> & {
      supportsControl(session: RegisteredSession): boolean | Promise<boolean>
      ingestPane(session: RegisteredSession, text: string, silent?: boolean): boolean | Promise<boolean>
    }
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  sendText: (terminalTarget: string, text: string) => Promise<boolean>
  /** Type without submitting. */
  sendLiteral: (terminalTarget: string, text: string) => Promise<boolean>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean>
  /** The pane's control, or null when it is busy. May wait: while the agent changes host, the daemon's waits for the
   *  move to end rather than refuse (hostMove/gate.ts `acquireAfterHold`). */
  acquireInput: (sessionId: string) => (() => void) | null | Promise<(() => void) | null>
}

export class RuntimeProfileController {
  constructor(private readonly deps: RuntimeProfileControllerDeps) {}

  async setProfile(sessionId: string, encoded: unknown): Promise<void> {
    const registeredSession = this.deps.getSession(sessionId)
    if (!registeredSession) throw new RuntimeProfileControlError('AGENT_NOT_FOUND')
    const observed = this.deps.manager.getState(registeredSession.sessionId)
    // Keep transaction cleanup on the conversation that began it, even if the registry row
    // is rebound in place while a native driver awaits its worker.
    const session: RegisteredSession = structuredClone(registeredSession)
    session.cliVersion ||= observed.cliVersion
    const native = this.deps.modelControlFor(session)
    const target = parseRuntimeProfile(encoded)
    // Either id identifies the agent: the encoded profile now carries the agent id, but one minted
    // before the id cutover (or by a client that still knows the session) must keep working.
    if (!target || (target.sessionId !== session.agentId && target.sessionId !== session.sessionId) || target.engine !== session.engine) {
      throw new RuntimeProfileControlError('INVALID_RUNTIME_PROFILE')
    }
    const current = parseRuntimeProfile(this.deps.manager.selectedModel(session))
    if (current?.id === target.id) return
    if (!native) throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    if (!await this.deps.manager.supportsControl(session)) {
      console.warn('[runtime-profile] UNSUPPORTED_CLI_VERSION')
      throw new RuntimeProfileControlError('UNSUPPORTED_CLI_VERSION')
    }
    await native?.validate({ stage: 'target', target, state: observed })
    const options = await this.deps.manager.modelsForSession(session)
    if (!options.some((option) => option.id === target.id)) {
      const sameModel = options.some((option) => parseRuntimeProfile(option.id)?.model === target.model)
      throw new RuntimeProfileControlError(sameModel ? 'EFFORT_UNSUPPORTED' : 'MODEL_UNAVAILABLE')
    }
    await native?.validate({ stage: 'scope', target, state: observed })
    const release = await this.deps.acquireInput(session.agentId)
    if (!release) {
      console.warn('[runtime-profile] BUSY (input held)')
      throw new RuntimeProfileControlError('BUSY')
    }
    let controlStarted = false
    let held = ''
    try {
      if (!await this.deps.validateRuntime(session)) throw new RuntimeProfileControlError('TMUX_FAILED')
      const capture = await this.deps.capture(session.agentId, 100)
      if (!capture) throw new RuntimeProfileControlError('TMUX_FAILED')
      const inspection = (await this.deps.readScreen(session, capture))?.pane
      held = 'screen unread'
      if (!inspection) throw new RuntimeProfileControlError('BUSY')
      held = 'scope'
      await native?.validate({ stage: 'scope', target, state: observed, pane: inspection })
      held = inspection.dialog ? 'dialog' : inspection.draft ? 'draft' : 'no prompt'
      if (!inspection.idle) throw new RuntimeProfileControlError('BUSY')
      held = 'switch unfinished'
      if (!this.deps.manager.beginControl(session, target)) throw new RuntimeProfileControlError('BUSY')
      held = ''
      controlStarted = true
      await native.apply({ target, current, options })
      this.deps.manager.finishControl(session)
      controlStarted = false
    } catch (error) {
      // By the engine session, as beginControl keyed it. `sessionId` is whichever id the request named,
      // and the apps name the agent: cancelling under that left the control in place, and every later
      // switch of the agent answered BUSY until the daemon restarted (found by e2e/models.e2e.ts, a
      // refused switch followed by one that should have gone through).
      if (controlStarted) this.deps.manager.cancelControl(session.sessionId)
      // A failed switch used to leave NOTHING in the log — the picker just flashed open and shut on the
      // user's terminal and the device said nothing useful. Name the session, engine and reason.
      const code = error instanceof RuntimeProfileControlError ? error.code : 'TMUX_FAILED'
      console.warn(`[runtime-profile] ${code}${code === 'BUSY' && held ? ` (${held})` : ''}`)
      if (error instanceof RuntimeProfileControlError) throw error
      throw new RuntimeProfileControlError('TMUX_FAILED')
    } finally {
      release()
    }
  }

}
