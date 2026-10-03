import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'

afterEach(() => vi.restoreAllMocks())

it.each(['memory', 'recall_memory', 'status', 'list_harnesses'])(
  'refuses retired optional %s requests without starting any feature service', async verb => {
    const socket = new BackendSocket('fixture')
    const frames: Array<{ type?: unknown; payload?: any }> = []
    vi.spyOn(socket, 'sendTo').mockImplementation((_to, frame) => { frames.push(frame) })
    socket.registerLocalClient('local:feature', { sendFrame: () => true, sendBinary: () => true }, { tool: true })
    try {
      socket.handleLocalFrame('local:feature', { type: 'pair', payload: {
        requestId: 'retired', verb, action: 'configure_experiment', enabled: true,
      } })
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'pair_result', payload: {
        requestId: 'retired', error: 'UNSUPPORTED',
      } }))
    } finally {
      await socket.unregisterLocalClient('local:feature')
      await socket.stop()
    }
  },
)
