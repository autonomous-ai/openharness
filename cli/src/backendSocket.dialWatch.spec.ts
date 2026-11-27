import { afterEach, expect, it, vi } from 'vitest'
import type { Frame } from './backendSocket.js'
import { relaySocket } from './testing/relaySocket.js'

afterEach(() => vi.restoreAllMocks())

const into = (frames: Frame[]) => ({ sendFrame: (frame: Frame) => { frames.push(frame); return true }, sendBinary: () => true })
const attached = { type: 'dial_status', payload: { attached: true, fw: '0.0.95' } }

// The menu-bar app's `harness hardware watch` is a tool on the local socket that asked for the dial: it is told the
// dial's status and nothing else this way, and it is never a window.
it('sends dial_status to a tool that asked for the dial, each time it changes, and to no other tool', async () => {
  const socket = relaySocket('fixture')
  const watcher: Frame[] = [], tool: Frame[] = [], window: Frame[] = []
  socket.registerLocalClient('local:watcher', into(watcher), { tool: true, watch: ['dial'] })
  socket.registerLocalClient('local:tool', into(tool), { tool: true })
  try {
    // Still no window: the machine list on the dial must not end because the menu-bar app is open.
    expect(socket.hasLocalClient()).toBe(false)
    expect(socket.localClientIds()).toEqual([])
    socket.registerLocalClient('local:window', into(window))
    const gone = { type: 'dial_status', payload: { attached: false } }
    socket.sendLocal(attached)
    socket.sendLocal(gone)
    socket.sendLocal({ type: 'dial_scroll', payload: { phase: 'move', dy: 1, velocity: 0 } })
    socket.sendLocal(() => attached) // a frame made per window is a window's
    expect(watcher).toEqual([attached, gone])
    expect(tool).toEqual([])
    expect(window.map((frame) => frame.type)).toEqual(['dial_status', 'dial_status', 'dial_scroll', 'dial_status'])
    await socket.unregisterLocalClient('local:watcher')
    // The same connection id back as a tool that did not ask: what the watcher asked went with it.
    socket.registerLocalClient('local:watcher', into(watcher), { tool: true })
    socket.sendLocal(attached)
    expect(watcher).toHaveLength(2)
  } finally {
    for (const id of ['local:watcher', 'local:tool', 'local:window']) await socket.unregisterLocalClient(id)
    await socket.stop()
  }
})

it('lets go of a watcher whose socket is gone', async () => {
  const socket = relaySocket('fixture')
  const sendFrame = vi.fn(() => false)
  socket.registerLocalClient('local:watcher', { sendFrame, sendBinary: () => true }, { tool: true, watch: ['dial'] })
  try {
    socket.sendLocal(attached)
    expect(sendFrame).toHaveBeenCalledTimes(1)
    expect(socket.isToolClient('local:watcher')).toBe(false)
    socket.sendLocal(attached)
    expect(sendFrame).toHaveBeenCalledTimes(1)
  } finally {
    await socket.unregisterLocalClient('local:watcher')
    await socket.stop()
  }
})

it('a window that names watch is a window', async () => {
  const socket = relaySocket('fixture')
  const window: Frame[] = []
  socket.registerLocalClient('local:w', into(window), { watch: ['dial'] })
  try {
    expect(socket.hasLocalClient()).toBe(true)
    socket.sendLocal(attached)
    expect(window).toEqual([attached])
  } finally {
    await socket.unregisterLocalClient('local:w')
    await socket.stop()
  }
})

it('send never reaches a watcher', async () => {
  const socket = relaySocket('fixture')
  const watcher: Frame[] = []
  socket.registerLocalClient('local:watcher', into(watcher), { tool: true, watch: ['dial'] })
  try {
    socket.send({ type: 'dial_status', payload: { attached: true } })
    expect(watcher).toEqual([])
  } finally {
    await socket.unregisterLocalClient('local:watcher')
    await socket.stop()
  }
})
