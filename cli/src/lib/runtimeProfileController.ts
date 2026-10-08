/** Explicit inline compatibility for direct controller users. */
export * from './runtimeControl.js'
export { inspectRuntimePane, paneModal } from '../engines/screens.js'
import { screenFor } from '../engines/screens.js'
import { RuntimeProfileController as Controller, type RuntimeProfileControllerDeps } from './runtimeControl.js'
export class RuntimeProfileController extends Controller {
  constructor(deps: Omit<RuntimeProfileControllerDeps, 'readScreen'> & Partial<Pick<RuntimeProfileControllerDeps, 'readScreen'>>) {
    super({ readScreen: async (session, capture) => capture === null ? null : screenFor(session.engine).inspect(capture), ...deps })
  }
}
