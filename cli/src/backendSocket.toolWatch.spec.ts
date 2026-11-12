import { afterEach, expect, it, vi } from 'vitest'
import { relaySocket } from './testing/relaySocket.js'

afterEach(() => vi.restoreAllMocks())

// An agent's `harness wait` and `watch` (agentClient/commands.ts) follow the harnesses they named by what the daemon
// pushes (core/toolWatches.ts), not by asking every 3 s; and a tool connection hears nothing else of this computer's.
it('pushes a tool only the state events of the harnesses it named, and stops when it goes', async () => {
  const socket = relaySocket('fixture')
  const tool: Array<{ type?: unknown; agentId?: unknown; payload?: any }> = []
  const window: Array<{ type?: unknown }> = []
  socket.registerLocalClient('local:tool', { sendFrame: (frame) => { tool.push(frame); return true }, sendBinary: () => true }, { tool: true })
  socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame); return true }, sendBinary: () => true })
  try {
    socket.handleLocalFrame('local:tool', { type: 'agents_watch', payload: { requestId: 'w', agentIds: ['a'] } })
    await vi.waitFor(() => expect(tool).toContainEqual({ type: 'agents_watch_result', payload: { requestId: 'w', ok: true } }))
    tool.length = 0
    socket.send({ type: 'text_delta', agentId: 'a', payload: { agentId: 'a', content: 'PRIVATE' } })
    socket.send({ type: 'turn_heartbeat', agentId: 'a', payload: { agentId: 'a', activity: { state: 'working' } } })
    socket.send({ type: 'turn_ended', agentId: 'b', payload: { agentId: 'b' } })
    socket.send({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a', activity: { state: 'idle' } } })
    const asked = { type: 'commander_question', agentId: 'a', payload: { requestId: 'q', questions: [{ q: 'PRIVATE' }] } }
    socket.sendCommander(asked)
    socket.sendLocal(asked)
    socket.sendCommander({ type: 'agent_deleted', payload: { agentId: 'a' } })
    expect(tool).toEqual([
      { type: 'agent_activity', agentId: 'a', payload: { agentId: 'a', state: 'working' } },
      { type: 'turn_ended', agentId: 'a', payload: { agentId: 'a', state: 'idle' } },
      { type: 'commander_question', agentId: 'a', payload: { agentId: 'a', requestId: 'q' } },
      { type: 'agent_deleted', agentId: 'a', payload: { agentId: 'a' } },
    ])
    // The window got all of it, as before.
    expect(window.map((f) => f.type)).toEqual(['text_delta', 'turn_heartbeat', 'turn_ended', 'turn_ended', 'commander_question'])
    expect(socket.followedByTool('a')).toBe(true)
    expect(socket.followedByTool('b')).toBe(false)
    await socket.unregisterLocalClient('local:tool')
    expect(socket.followedByTool('a')).toBe(false)
    socket.registerLocalClient('local:tool', { sendFrame: (frame) => { tool.push(frame); return true }, sendBinary: () => true }, { tool: true })
    tool.length = 0
    socket.send({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    expect(tool).toEqual([])
  } finally {
    await socket.unregisterLocalClient('local:tool')
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  }
})
