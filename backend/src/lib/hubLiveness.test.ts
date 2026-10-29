import { afterAll, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'

vi.mock('./bus.js', () => ({
  setAgentClientCount: vi.fn(async () => undefined), setAgentClientCountsBatch: vi.fn(async () => undefined),
  getAgentClientState: vi.fn(async () => ({ totals: { ui: 0, commander: 0, commanderActive: 0 }, commanderJoinGeneration: undefined })),
  bumpCommanderJoinGeneration: vi.fn(async () => 1), publishDown: vi.fn(async () => 1), publishUp: vi.fn(async () => 1),
  publishTerminalDown: vi.fn(async () => 1), subscribeUp: vi.fn(async () => () => undefined), subscribeTerminalUp: vi.fn(async () => () => undefined),
}))
vi.mock('./providerLink.js', () => ({ routeDown: async (_m: string, _d: unknown, fallback: () => Promise<number>) => fallback() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

// The sweep's interval starts when the module loads, so the clock is fake before it does.
vi.useFakeTimers()
const { trackSocketLiveness, CLIENT_IDLE_DEADLINE_MS } = await import('./hub.js')
const { logger } = await import('../utils/logger.js')
afterAll(() => { vi.useRealTimers() })

function socket() {
  const listeners = new Map<string, () => void>()
  const ws = { readyState: 1, ping: vi.fn(), terminate: vi.fn(() => { ws.readyState = 3 }),
    on: (event: string, listener: () => void) => { listeners.set(event, listener) } }
  return { ws: ws as unknown as WebSocket, ping: ws.ping, terminate: ws.terminate, hear: (event: string) => listeners.get(event)!() }
}
const timedOut = () => vi.mocked(logger.warn).mock.calls.filter(([message]) => message === 'hub client heartbeat timed out').map(([, info]) => info)

// Prod logs 2026-10-28: 40–78 of these every 10 minutes, most saying only `tracked`, so nobody could tell which clients went
// silent, or whether they ever answered a ping (a client that cannot) or stopped answering (a computer that slept).
describe('a socket that stops answering', () => {
  it('is closed past its deadline, and the log names its client, its age and the pings it left unanswered', async () => {
    vi.mocked(logger.warn).mockClear()
    const answered = socket(), silent = socket()
    trackSocketLiveness(answered.ws, 'web')
    trackSocketLiveness(silent.ws, 'observer')
    await vi.advanceTimersByTimeAsync(30_000)
    answered.hear('pong')
    await vi.advanceTimersByTimeAsync(CLIENT_IDLE_DEADLINE_MS + 5_000)
    expect(silent.terminate).toHaveBeenCalledOnce()
    expect(answered.terminate).toHaveBeenCalledOnce()
    const [observer, web] = timedOut() as Array<Record<string, unknown>>
    // A ping every third of the deadline, at 5, 30 and 55 s: none answered, closed at 75 s. The web client answered the one at
    // 30 s and left those at 55 and 80 s unanswered, closed at 105 s.
    expect(observer).toMatchObject({ kind: 'tracked', client: 'observer', answered: false, unansweredPings: 3, idleMs: 75_000, connectedMs: 75_000 })
    expect(web).toMatchObject({ kind: 'tracked', client: 'web', answered: true, unansweredPings: 2, idleMs: 75_000, connectedMs: 105_000 })
  })
})
