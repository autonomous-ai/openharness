import { describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'

/** The request gate: a daemon that is still starting answers nothing, and then everything, in order. */
describe('BackendSocket request gate', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  const client = (socket: BackendSocket, connId: string) => {
    const frames: Array<Record<string, any>> = []
    socket.registerLocalClient(connId, { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    return frames
  }

  it('answers at once when nothing holds it — the way every socket but the daemon\'s is built', async () => {
    const socket = new BackendSocket('fixture')
    const cancelled: string[] = []
    socket.onCancel = (target) => cancelled.push(target)
    client(socket, 'local:open')
    socket.handleLocalFrame('local:open', { type: 'cancel', payload: { agentId: 'a1' } })
    await settle()
    expect(cancelled).toEqual(['a1'])
  })

  it('holds requests until it is opened, then dispatches them in the order they came', async () => {
    const socket = new BackendSocket('fixture')
    socket.holdRequests()
    socket.holdRequests()
    const cancelled: string[] = []
    client(socket, 'local:held')
    socket.handleLocalFrame('local:held', { type: 'cancel', payload: { agentId: 'a1' } })
    socket.handleLocalFrame('local:held', { type: 'cancel', payload: { agentId: 'a2' } })
    await settle()
    // Wired only now, as start-up would: the held requests meet the handler, not its absence.
    socket.onCancel = (target) => cancelled.push(target)
    expect(cancelled).toEqual([])
    socket.openRequests()
    socket.openRequests()
    await settle()
    expect(cancelled).toEqual(['a1', 'a2'])
    socket.handleLocalFrame('local:held', { type: 'cancel', payload: { agentId: 'a3' } })
    await settle()
    expect(cancelled).toEqual(['a1', 'a2', 'a3'])
  })

  it('closes a local client that floods a daemon still starting, and keeps the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const socket = new BackendSocket('fixture')
      socket.holdRequests()
      const cancelled: string[] = []
      socket.onCancel = (target) => cancelled.push(target)
      client(socket, 'local:flood')
      client(socket, 'local:calm')
      for (let i = 0; i < 300; i++) socket.handleLocalFrame('local:flood', { type: 'cancel', payload: { agentId: `f${i}` } })
      socket.handleLocalFrame('local:calm', { type: 'cancel', payload: { agentId: 'calm' } })
      await settle()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain('sent 257 requests before the daemon was ready — closing it')
      expect(socket.localClientIds()).not.toContain('local:flood')
      socket.handleLocalFrame('local:flood', { type: 'cancel', payload: { agentId: 'gone' } })
      socket.openRequests()
      await settle()
      // What it queued before it was closed is still answered; nothing after.
      expect(cancelled.filter((target) => target.startsWith('f'))).toHaveLength(256)
      expect(cancelled).toContain('calm')
      expect(cancelled).not.toContain('gone')
    } finally {
      warn.mockRestore()
    }
  })
})
