/** Explicit inline compatibility for direct controller users. */
export * from './runtimeControl.js'
export { inspectRuntimePane, paneModal } from '../engines/screens.js'
import { screenFor } from '../engines/screens.js'
import { modelControlFor } from '../engines/modelControls.js'
import { RuntimeProfileController as Controller, type RuntimeProfileControllerDeps } from './runtimeControl.js'
export class RuntimeProfileController extends Controller {
  constructor(deps: Omit<RuntimeProfileControllerDeps, 'readScreen' | 'modelControlFor'> & Partial<Pick<RuntimeProfileControllerDeps, 'readScreen' | 'modelControlFor'>>) {
    super({
      readScreen: async (session, capture) => capture === null ? null : screenFor(session.engine).inspect(capture),
      modelControlFor: session => {
        const control = modelControlFor(session.engine)
        if (!control) return undefined
        const catalog = () => deps.manager.codexCatalog(session)
        let snapshot: Awaited<ReturnType<typeof catalog>> = []
        return {
          validate: async check => {
            if (check.stage === 'target') snapshot = await catalog()
            await control.validate({ ...check, session, catalog: snapshot })
          },
          apply: input => control.apply({ ...input, session, catalog: snapshot }, {
            catalog, capture: async (lines, observe) => {
              const text = await deps.capture(session.agentId, lines)
              if (observe && text && session.sessionId) await deps.manager.ingestPane(session, text, true)
              return text
            },
            text: text => deps.sendText(session.agentId, text), literal: text => deps.sendLiteral(session.agentId, text), key: key => deps.sendKey(session.agentId, key),
            waitForModel: ms => deps.manager.waitForModel(session.sessionId, ms),
            waitForProfile: ms => deps.manager.waitForProfile(session.sessionId, ms),
            confirmEffort: async effort => { deps.manager.confirmEffort(session.sessionId, effort) },
          }),
        }
      }, ...deps,
    })
  }
}
