import type { ServiceRequests } from '../../core/api.js'
import type { EngineScreen } from '../facets/screen.js'
import type { ReaderEngine } from './protocol.js'
import { screenCapture, screenReading, SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_READ,
  SCREEN_REPLY_BYTES, SCREEN_VERSION, SCREEN_WAIT_MS } from './screenProtocol.js'
import { snapshotRequests } from './snapshotRequests.js'

const loadScreen = {
  claude: async () => (await import('../claude/screen.js')).screen,
  codex: async () => (await import('../codex/screen.js')).screen,
}
export interface ScreenRequestDeps { load?: () => Promise<EngineScreen>; recycle?: () => void }

export function engineScreenRequests(engine: ReaderEngine, deps: ScreenRequestDeps = {}): ServiceRequests {
  return snapshotRequests<EngineScreen>({
    engine, version: SCREEN_VERSION, capabilities: SCREEN_CAPABILITIES, capability: 'screen',
    inFlight: SCREEN_IN_FLIGHT, waitMs: SCREEN_WAIT_MS, replyBytes: SCREEN_REPLY_BYTES,
    load: deps.load ?? loadScreen[engine], recycle: () => (deps.recycle ?? (() => process.exit(1)))(),
    methods: {
      [SCREEN_READ]: {
        fields: ['capture'], accepts: payload => screenCapture(payload.capture),
        answer: (adapter, payload) => adapter.inspect(payload.capture as string),
        valid: answer => screenReading(answer),
      },
    },
  })
}
