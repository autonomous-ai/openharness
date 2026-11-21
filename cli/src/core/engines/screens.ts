import { captureSessionBinding } from './sessionBinding.js'
import type { ScreenReading } from '../../engines/facets/screen.js'
import type { AgentEngine } from '../../engines/types.js'
import { screenCapture } from '../../engines/worker/screenProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ScreenReader } from '../../lib/screenReader.js'
import type { ScreenTransport } from './screenTransport.js'
import { EngineReadError } from '../../engines/worker/protocol.js'

export interface ScreenDeps {
  handles(engine: AgentEngine): boolean
  transport: Pick<ScreenTransport, 'read'>
  resolve(id: string): RegisteredSession | undefined
  /** Explicit inline/older-master compatibility only. `undefined` reads as unreadable. */
  inline(engine: AgentEngine, capture: string | null): ScreenReading | undefined | Promise<ScreenReading | undefined>
}

export function createScreens(deps: ScreenDeps) {
  const read: ScreenReader = async (session, capture) => {
    if (capture !== null && !screenCapture(capture)) return null
    const sameBinding = captureSessionBinding(session), engine = session.engine, agentId = session.agentId
    if (!agentId || !sameBinding(deps.resolve(agentId))) return null
    try {
      const answer = deps.handles(engine) ? capture === null && engine !== 'terminal' ? null : await deps.transport.read(engine, capture) : await deps.inline(engine, capture)
      return sameBinding(deps.resolve(agentId)) && answer ? answer : null
    } catch { return null }
  }
  return {
    read,
    async question(session: RegisteredSession, capture: string) {
      const screen = await read(session, capture)
      if (!screen) throw new EngineReadError('ENGINE_UNAVAILABLE')
      return screen.question
    },
  }
}
