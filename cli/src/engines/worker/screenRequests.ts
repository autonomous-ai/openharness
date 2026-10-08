import type { ServiceRequests } from '../../core/api.js'
import type { EngineScreen } from '../facets/screen.js'
import type { ReaderEngine } from './protocol.js'
import { screenCapture, screenReading, SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_READ,
  SCREEN_REPLY_BYTES, SCREEN_VERSION, SCREEN_WAIT_MS } from './screenProtocol.js'

const loadScreen = {
  claude: async () => (await import('../claude/screen.js')).screen,
  codex: async () => (await import('../codex/screen.js')).screen,
}
export interface ScreenRequestDeps { load?: () => Promise<EngineScreen>; recycle?: () => void }

export function engineScreenRequests(engine: ReaderEngine, deps: ScreenRequestDeps = {}): ServiceRequests {
  let loaded: Promise<EngineScreen> | null = null
  let pending = 0
  const failure = (error: string) => ({ version: SCREEN_VERSION, error })
  const handle = (method: string): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== SCREEN_VERSION) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    if (method === SCREEN_CAPABILITIES) return { version: SCREEN_VERSION, screen: SCREEN_VERSION, engine }
    // ServiceLinks adds its routing id inside the payload. It is transport
    // metadata, not a terminal capability or engine input.
    if (!screenCapture(payload.capture) || Object.keys(payload).some(key => !['version', 'capture', 'requestId'].includes(key))
      || (payload.requestId !== undefined && (typeof payload.requestId !== 'string' || payload.requestId.length > 200))) return failure('ENGINE_INVALID_REQUEST')
    if (pending >= SCREEN_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>(resolve => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); (deps.recycle ?? (() => process.exit(1)))() }, SCREEN_WAIT_MS)
    })
    try {
      const capture = payload.capture
      return await Promise.race([deadline, (async () => {
        const adapter = await (loaded ??= (deps.load ?? loadScreen[engine])().catch(error => { loaded = null; throw error }))
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const answer = adapter.inspect(capture)
        const reply = { version: SCREEN_VERSION, answer }
        if (Buffer.byteLength(JSON.stringify(reply)) > SCREEN_REPLY_BYTES) return failure('ENGINE_REPLY_TOO_LARGE')
        return screenReading(answer) ? reply : failure('ENGINE_INVALID_REPLY')
      })()])
    } catch { return failure('ENGINE_UNAVAILABLE') }
    finally { clearTimeout(timer); pending-- }
  }
  return { [SCREEN_CAPABILITIES]: handle(SCREEN_CAPABILITIES), [SCREEN_READ]: handle(SCREEN_READ) }
}
