import { expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { addClient, clientCounts, removeClient } from './registry.js'

// A daemon stops a machine's live events while `ui` is 0 (spec 2026-11-02-swarm-cache-delta-design, Part 4), so every
// client that receives web-eligible frames must add to it. Desktop, the web app and the phone all attach as 'web'
// (webWs.ts); a guest is a web client too and must keep the gate open for the frames sealed for it.
it('ui counts web and guest web clients, never commanders', () => {
  const machineId = `registry-ui-${Date.now()}`
  const socket = {} as WebSocket
  addClient({ connId: 'desktop', machineId, kind: 'web', socket })
  addClient({ connId: 'phone', machineId, kind: 'web', socket })
  addClient({ connId: 'guest', machineId, kind: 'web', socket, guest: true })
  addClient({ connId: 'device', machineId, kind: 'commander', socket, active: true })
  try {
    expect(clientCounts(machineId)).toEqual({ ui: 3, commander: 1, commanderActive: 1 })
  } finally {
    for (const connId of ['desktop', 'phone', 'guest', 'device']) removeClient(machineId, connId)
  }
  expect(clientCounts(machineId)).toEqual({ ui: 0, commander: 0, commanderActive: 0 })
})
