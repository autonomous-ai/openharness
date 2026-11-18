import type { ServiceRequests } from '../../core/api.js'
import type { EngineScreen, ScreenReading } from '../facets/screen.js'
import type { WorkerEngine, ReaderEngine } from './protocol.js'
import { screenCapture, screenReading, SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_READ,
  SCREEN_REPLY_BYTES, SCREEN_VERSION, SCREEN_WAIT_MS } from './screenProtocol.js'
import { snapshotRequests } from './snapshotRequests.js'

const loadScreen = {
  claude: async () => (await import('../claude/screen.js')).screen,
  codex: async () => (await import('../codex/screen.js')).screen,
}
export interface ScreenRequestDeps { load?: () => Promise<EngineScreen>; recycle?: () => void }

export function engineScreenRequests(engine: WorkerEngine | 'terminal', deps: ScreenRequestDeps = {}): ServiceRequests {
  return snapshotRequests<(capture: string | null) => ScreenReading>({
    engine, version: SCREEN_VERSION, capabilities: SCREEN_CAPABILITIES, capability: 'screen',
    inFlight: SCREEN_IN_FLIGHT, waitMs: SCREEN_WAIT_MS, replyBytes: SCREEN_REPLY_BYTES,
    load: engine === 'terminal' ? async () => (await import('../kit/screen.js')).terminalScreen : async () => {
      const adapter = await (deps.load ?? loadScreen[engine as ReaderEngine])()
      // Only the terminal request admits null, and its reader is selected above.
      return capture => adapter.inspect(capture as string)
    }, recycle: () => (deps.recycle ?? (() => process.exit(1)))(),
    methods: {
      [SCREEN_READ]: {
        fields: ['capture'], accepts: payload => engine === 'terminal' && payload.capture === null || screenCapture(payload.capture),
        answer: (inspect, payload) => inspect(payload.capture as string | null),
        valid: answer => screenReading(answer, engine),
      },
    },
  })
}
