import { describe, expect, it, vi } from 'vitest'
import { wifiDoors } from './wifiAgents.js'

describe('the Wi-Fi device\'s doors into the core', () => {
  function doorsWith(over: { window?: boolean; socket?: boolean; devices?: boolean } = {}) {
    const socket = { hasLocalClient: vi.fn(() => over.window !== false), onCreateAgent: null }
    const devices = { stepFocus: vi.fn(async () => ({ machineId: 'mac', agentId: 'a' })), scroll: vi.fn() }
    const doors = wifiDoors({
      socket: () => (over.socket === false ? null : socket),
      devices: () => (over.devices === false ? null : devices),
    })
    return { doors, socket, devices }
  }

  it('walks the desk and scrolls through the dials\' own, with a window to show it', async () => {
    const { doors, devices } = doorsWith()
    expect(await doors.stepFocus('next', 'a')).toEqual({ machineId: 'mac', agentId: 'a' })
    expect(devices.stepFocus).toHaveBeenCalledWith('next', 'a')
    expect(doors.scroll('move', 4, 10)).toBe(true)
    expect(devices.scroll).toHaveBeenCalledWith('move', 4, 10)
    expect(await doorsWith({ window: false }).doors.stepFocus('next')).toBe('no_app')
    expect(doorsWith({ window: false }).doors.scroll('down', 0, 0)).toBe(false)
    expect(await doorsWith({ devices: false }).doors.stepFocus('previous')).toBe('no_agents')
    expect(doorsWith({ devices: false }).doors.scroll('up', 0, 0)).toBe(true)
  })

  it('owns no feature-specific window payload builder', () => {
    const { doors } = doorsWith()
    expect(doors).not.toHaveProperty('focusApp')
    expect(doors).not.toHaveProperty('reveal')
  })
})
